// The real J.P. Morgan HTTP client — the ONE module that touches the network, so (like the sibling
// Invesco / iShares workers' clients) it is exercised live, not by the unit tests, which drive the
// pure driver in jpmorgan.ts through an injected fake `get`.
//
// J.P. Morgan's public FundsMarketingHandler BFF (am.jpmorgan.com) is keyless and un-gated, so there
// is no login/token handshake. Two things the client sets, defensively:
//   • A browser-like User-Agent + a `Referer: https://am.jpmorgan.com/` — plain fetch reaches the
//     endpoints today, but a browser-shaped request is the safe posture against future gating (and
//     matches the sibling workers).
//   • Transient 5xx retry with backoff — turns an intermittent edge error into a 200 on retry. So
//     the client retries idempotent GETs on 5xx.
//
// The `version` query token JPM's own site appends is an OPTIONAL cache-buster, not auth; omitting
// it serves current data (verified), so the client sends none — nothing to keep fresh.
//
// CATALOG CACHE: the /fund-explorer catalog backs both `products` and every ticker→CUSIP
// resolution, and it changes at most once a day. So the client memoizes just that one URL with a
// 24 h TTL (shared across queries in a long-lived stdio/HTTP process). Everything else — holdings,
// fund_details — always goes live. The in-flight Promise is cached (not only the resolved value) so
// concurrent first requests coalesce into a single fetch; a failed fetch is evicted so the next
// call retries.

import type { JpmorganGet } from "./functions.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Default catalog cache lifetime: 24 hours. */
export const CATALOG_CACHE_MS = 24 * 60 * 60 * 1000;
/** How many times to retry a GET that returns a 5xx (the edge's transient errors). */
export const MAX_RETRIES = 4;

type FetchLike = typeof globalThis.fetch;

export interface JpmorganClientOptions {
  /** Catalog cache TTL in ms (default 24 h). Pass 0 to disable caching. */
  catalogCacheMs?: number;
  /** Injectable clock (ms since epoch) — for tests. Defaults to Date.now. */
  now?: () => number;
  /** Max 5xx retries (default MAX_RETRIES). */
  maxRetries?: number;
  /** Injectable sleep (ms) — for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the injectable `get(url) => parsed JSON` the table functions call. `fetchImpl` defaults to
 * the platform fetch; pass one in for Cloudflare or to stub the network. The /fund-explorer catalog
 * response is memoized for `catalogCacheMs` (default 24 h); 5xx responses are retried.
 */
export function makeJpmorganGet(
  fetchImpl: FetchLike = globalThis.fetch,
  opts: JpmorganClientOptions = {},
): JpmorganGet {
  const ttl = opts.catalogCacheMs ?? CATALOG_CACHE_MS;
  const now = opts.now ?? (() => Date.now());
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let catalog: { at: number; value: Promise<unknown> } | null = null;

  const rawGet = async (url: string): Promise<unknown> => {
    let lastBody = "";
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetchImpl(url, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json,*/*",
          Referer: "https://am.jpmorgan.com/",
        },
      });
      if (res.ok) return res.json();
      lastBody = await res.text().catch(() => "");
      // Retry only transient server errors; client errors are terminal.
      if (res.status >= 500 && attempt < maxRetries) {
        await sleep(250 * (attempt + 1));
        continue;
      }
      throw new Error(`jpmorgan: HTTP ${res.status} for ${url} — ${lastBody.slice(0, 200)}`);
    }
    // Unreachable (the loop returns or throws), but satisfies the type checker.
    throw new Error(`jpmorgan: exhausted retries for ${url} — ${lastBody.slice(0, 200)}`);
  };

  return async (url: string): Promise<unknown> => {
    if (ttl > 0 && url.includes("/fund-explorer")) {
      const t = now();
      if (!catalog || t - catalog.at >= ttl) {
        const value = rawGet(url);
        catalog = { at: t, value };
        // Evict a rejected fetch so the next call retries instead of caching the error.
        value.catch(() => {
          if (catalog && catalog.value === value) catalog = null;
        });
      }
      return catalog.value;
    }
    return rawGet(url);
  };
}
