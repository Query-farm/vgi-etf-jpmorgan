// The J.P. Morgan Asset Management driver — pure logic, no network and no SDK. Every fetch* takes
// an injected `get(url) => Promise<any>` so the archetype-proof tests drive it against an
// in-process fake and the worker wires the real HTTP client (client.ts). This module MUST NOT
// import from @query-farm/* — the unit tests import it without the SDK installed.
//
// J.P. Morgan exposes a KEYLESS JSON "BFF" (backend-for-frontend) on am.jpmorgan.com. Two planes
// back the tables and functions, both under /FundsMarketingHandler/:
//
//   /fund-explorer?fundType=etf&country=us&role=adv&language=en   → products (the ETF catalog, one
//     object per US ETF; also the ticker→CUSIP resolver)
//   /product-data?cusip=<CUSIP>&country=us&role=adv&language=en&userLoggedIn=false
//                                                                 → holdings + fund_details (one big
//     per-fund object keyed by CUSIP, ~200-900 KB)
//
// The per-fund plane keys funds by CUSIP, so we resolve ticker→CUSIP against the (cached) catalog
// and hit product-data with idType cusip (mirrors how the sibling Invesco / iShares workers resolve
// ticker→id).
//
// Every parser is defensive: a missing key / container / array degrades to an empty result or a
// null cell rather than throwing (a bad CUSIP returns `{fundData:null}`). `resolveFund` returns
// null (not a throw) on an unresolvable ticker so the caller (functions.ts) can raise a typed SDK
// error.
//
// IMPORTANT — J.P. Morgan holdings are CURRENT-only: product-data carries a single effective date
// per fund, with no arbitrary historical as-of. So `holdings` is hive-partitioned by fund but has
// NO time travel. product-data also carries no distribution or NAV time series, so there are no
// distributions / nav_history functions (unlike the Invesco sibling).
//
// A NOTE ON THE `version` TOKEN: the BFF accepts an optional `version=9.13_<digits>` query param
// whose digits rotate; it is a cache-buster, not auth. Omitting it serves current data all the
// same (verified), so the client sends no version — there is no fragile token to keep fresh.

export const JPM_HOST = "https://am.jpmorgan.com/FundsMarketingHandler";

/** The US ETF product catalog: one object per open ETF. Backs products + resolveFund. */
export const CATALOG_URL =
  `${JPM_HOST}/fund-explorer?fundType=etf&country=us&role=adv&language=en`;

/** Build the per-fund product-data URL for a CUSIP (holdings + characteristics). */
export function productDataUrl(cusip: string): string {
  const qs = new URLSearchParams({
    cusip: cusip.trim(),
    country: "us",
    role: "adv",
    language: "en",
    userLoggedIn: "false",
  });
  return `${JPM_HOST}/product-data?${qs.toString()}`;
}

// ── shared value coercion ────────────────────────────────────────────────────

/** True for "no data" cells: null, "", all-whitespace, or the "-" / "N/A" sentinels JPM emits. */
function isBlank(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" || t === "-" || t === "N/A";
  }
  return false;
}

/** A trimmed display string, or null when blank. */
export function str(v: unknown): string | null {
  if (isBlank(v)) return null;
  return String(v).trim();
}

/**
 * A number from a JPM value. Handles bare numbers and string forms ("0.35", "1,182,200") — strips
 * `$`, `,`, `%`, and spaces. Null when blank / non-numeric.
 */
export function num(v: unknown): number | null {
  if (isBlank(v)) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * A FRACTION (JPM emits returns / yields / premium-discount as fractions: 0.0777 = 7.77%) → percent
 * POINTS (7.77), so the `_percent` columns hold percent-magnitude numbers like every sibling
 * worker. Rounded to 8 decimals to shed float-multiplication noise. Null when blank / non-numeric.
 * NOTE: expense ratios, coupon rates, and holding weights already arrive in percent points, so
 * those use `num()`, not `pct()`.
 */
export function pct(v: unknown): number | null {
  const n = num(v);
  if (n == null) return null;
  return Math.round(n * 100 * 1e8) / 1e8;
}

/**
 * A JPM date → epoch SECONDS at UTC midnight of the CALENDAR day. Accepts ISO `YYYY-MM-DD` (what
 * the BFF emits) and, defensively, US `MM/DD/YYYY`. We keep only the calendar parts so no zone
 * offset can shift the reported day. Null when absent / unparseable; validates the parts round-trip
 * so an impossible date returns null.
 */
export function dateSec(v: unknown): number | null {
  if (isBlank(v)) return null;
  const s = String(v).trim();
  let y: number, mo: number, d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    y = Number(iso[1]);
    mo = Number(iso[2]);
    d = Number(iso[3]);
  } else {
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
    if (!us) return null;
    mo = Number(us[1]);
    d = Number(us[2]);
    y = Number(us[3]);
  }
  const ms = Date.UTC(y, mo - 1, d);
  if (Number.isNaN(ms)) return null;
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.floor(ms / 1000);
}

/** Decode the few HTML entities JPM leaves in prose (e.g. `S&amp;P`). */
export function decodeEntities(s: string | null): string | null {
  if (s == null) return null;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

/**
 * Clean a JPM prose blob to plain text: strip HTML tags, decode entities, and turn the `~~` bullet
 * separators JPM uses in `strategy` into "; ". Null / whitespace-only degrades to null.
 */
export function cleanText(v: unknown): string | null {
  const s = str(v);
  if (s == null) return null;
  const out = decodeEntities(s.replace(/~~/g, "; ").replace(/<[^>]+>/g, " "))
    ?.replace(/\s+/g, " ")
    .trim();
  return out ? out : null;
}

/** Map JPM's managementStyle code to a readable label ("A" → Active, "P" → Passive). */
function managementStyle(v: unknown): string | null {
  const s = str(v);
  if (s == null) return null;
  if (s.toUpperCase() === "A") return "Active";
  if (s.toUpperCase() === "P") return "Passive";
  return s;
}

/** Take a nested return-series member (e.g. atNavPerformanceReturn.yr1) as percent points. */
function seriesPct(obj: unknown, key: string): number | null {
  if (obj == null || typeof obj !== "object") return null;
  return pct((obj as Record<string, unknown>)[key]);
}

// ── products (the /fund-explorer catalog) ───────────────────────────────────────

export interface ProductRow {
  ticker: string | null;
  cusip: string | null;
  name: string | null;
  display_name: string | null;
  asset_class: string | null;
  management_style: string | null;
  fund_type_code: string | null;
  currency: string | null;
  morningstar_rating: number | null;
  inception_date: number | null;
  net_assets: number | null;
  nav: number | null;
  nav_date: number | null;
  market_price: number | null;
  premium_discount_percent: number | null;
  sec_yield_percent: number | null;
  ytd_return_percent: number | null;
  return_1y_percent: number | null;
  return_3y_percent: number | null;
  return_5y_percent: number | null;
  return_10y_percent: number | null;
  return_since_inception_percent: number | null;
  kiid_url: string | null;
}

/** Map one fund-explorer catalog object to a product row. */
export function parseProductDoc(doc: unknown): ProductRow | null {
  if (doc == null || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;
  const ticker = str(d.ticker) ?? str(d.displayId);
  if (!ticker) return null;
  const nav = d.atNavPerformanceReturn;
  return {
    ticker: ticker.toUpperCase(),
    cusip: str(d.identifier),
    name: decodeEntities(str(d.name)),
    display_name: decodeEntities(str(d.displayName)),
    asset_class: str(d.assetClass),
    management_style: managementStyle(d.managementStyle),
    fund_type_code: str(d.fundTypeCode),
    currency: str(d.currencyCode),
    morningstar_rating: num(d.morningStarRating),
    inception_date: dateSec(d.fundInceptionDate) ?? dateSec(d.shareClassInceptionDate),
    net_assets: num(d.assetsUnderManagement),
    nav: num(d.nav),
    nav_date: dateSec(d.navDate),
    market_price: num(d.marketPrice),
    premium_discount_percent: pct(d.premiumDiscountPercentage),
    sec_yield_percent: pct(d.secYield),
    ytd_return_percent: pct(d.ytdReturn),
    return_1y_percent: seriesPct(nav, "yr1"),
    return_3y_percent: seriesPct(nav, "yr3"),
    return_5y_percent: seriesPct(nav, "yr5"),
    return_10y_percent: seriesPct(nav, "yr10"),
    return_since_inception_percent: seriesPct(nav, "inception"),
    kiid_url: str(d.kiidUrl),
  };
}

/**
 * Map the fund-explorer array to product rows. `ticker`, when non-empty, narrows to that one ticker
 * (case-insensitive). Rows without a ticker are dropped.
 */
export function parseProducts(json: unknown, ticker = ""): ProductRow[] {
  const arr = Array.isArray(json) ? json : [];
  const wantTicker = ticker.trim().toUpperCase();
  const rows: ProductRow[] = [];
  for (const doc of arr) {
    const row = parseProductDoc(doc);
    if (!row || !row.ticker) continue;
    if (wantTicker && row.ticker !== wantTicker) continue;
    rows.push(row);
  }
  return rows;
}

export async function fetchProducts(
  get: (url: string) => Promise<unknown>,
  ticker = "",
): Promise<ProductRow[]> {
  return parseProducts(await get(CATALOG_URL), ticker);
}

// ── fund resolution (accept a ticker or a CUSIP; validate against the catalog) ────

/**
 * Resolve a `fund` argument to its catalog row. A `fund` may be an exchange ticker (e.g. 'JEPI') or
 * a raw CUSIP; both are matched (case-insensitive) against the cached catalog, so the caller gets
 * the fund's CUSIP (what product-data is keyed by) plus its identity fields. Returns null when
 * nothing matches (the caller raises a typed ArgumentValidationError — this module stays SDK-free).
 */
export async function resolveFund(
  get: (url: string) => Promise<unknown>,
  fund: string,
): Promise<ProductRow | null> {
  const wanted = fund.trim().toUpperCase();
  if (wanted === "") return null;
  const products = parseProducts(await get(CATALOG_URL));
  return (
    products.find(
      (p) =>
        (p.ticker ?? "").toUpperCase() === wanted || (p.cusip ?? "").toUpperCase() === wanted,
    ) ?? null
  );
}

// ── holdings (product-data → fundData.dailyHoldingsAll) ─────────────────────────

export interface HoldingRow {
  /** The fund's ticker — the partition key (constant per fund; distinct from the constituent `ticker`). */
  fundTicker: string | null;
  asOfDate: number | null;
  name: string | null;
  ticker: string | null;
  cusip: string | null;
  weightPercent: number | null;
  marketValue: number | null;
  shares: number | null;
  secType: string | null;
  sector: string | null;
  industry: string | null;
  country: string | null;
  currency: string | null;
  // Fixed-income-leaning fields (null for most equity positions).
  couponPercent: number | null;
  maturityDate: number | null;
  rating: string | null;
  yieldPercent: number | null;
}

/** Pull the fundData envelope out of a product-data response (tolerates either shape). */
function fundDataOf(json: unknown): Record<string, unknown> {
  const o = (json as Record<string, unknown> | null | undefined) ?? {};
  const fd = (o.fundData as Record<string, unknown> | null | undefined) ?? o;
  return (fd as Record<string, unknown> | null | undefined) ?? {};
}

/**
 * Map a product-data envelope's FULL holdings (fundData.dailyHoldingsAll.data — the complete
 * position list, not the top-10 `dailyHoldings`) to holding rows, sorted by weight desc (NULLS
 * last). The as-of date is the holdings block's effectiveDate.
 */
export function parseHoldings(json: unknown, fundTicker: string | null = null): HoldingRow[] {
  const fd = fundDataOf(json);
  const block =
    (fd.dailyHoldingsAll as Record<string, unknown> | null | undefined) ??
    (fd.dailyHoldings as Record<string, unknown> | null | undefined) ??
    {};
  const asOf = dateSec(block.effectiveDate);
  const list = block.data;
  if (!Array.isArray(list)) return [];
  const rows: HoldingRow[] = [];
  for (const raw of list) {
    if (raw == null || typeof raw !== "object") continue;
    const h = raw as Record<string, unknown>;
    rows.push({
      fundTicker,
      asOfDate: asOf ?? dateSec(h.navDate),
      name: decodeEntities(str(h.securityDescription)),
      ticker: str(h.securityTicker),
      // securityCusip is usually null but securityId carries the CUSIP.
      cusip: str(h.securityCusip) ?? str(h.securityId),
      weightPercent: num(h.marketValuePercent) ?? num(h.netAssetValuePercent),
      marketValue: num(h.marketValue),
      shares: num(h.shares),
      secType: str(h.securityType),
      sector: str(h.sector),
      industry: str(h.industry),
      country: str(h.country),
      currency: str(h.currencyCode),
      couponPercent: num(h.couponRate),
      maturityDate: dateSec(h.finalLegalMaturityDate) ?? dateSec(h.wamMaturityDate),
      rating: str(h.snpRating) ?? str(h.moodysRating) ?? str(h.fitchRating),
      yieldPercent: num(h.securityYield),
    });
  }
  // JPM returns holdings weight-descending already; enforce it so `... LIMIT 10` is the top
  // holdings without an explicit ORDER BY. NULL weights sort last.
  rows.sort((a, b) => (b.weightPercent ?? -Infinity) - (a.weightPercent ?? -Infinity));
  return rows;
}

/** Detailed current holdings for one fund (by CUSIP). Returns JPM's published positions. */
export async function fetchHoldings(
  get: (url: string) => Promise<unknown>,
  cusip: string,
  fundTicker: string,
): Promise<HoldingRow[]> {
  return parseHoldings(await get(productDataUrl(cusip)), fundTicker.toUpperCase());
}

// ── fund_details (catalog identity + product-data profile, merged to one row) ─────

export interface FundDetailsRow {
  ticker: string | null;
  cusip: string | null;
  name: string | null;
  asset_class: string | null;
  management_style: string | null;
  inception_date: number | null;
  expense_ratio_percent: number | null;
  gross_expense_ratio_percent: number | null;
  net_assets: number | null;
  num_holdings: number | null;
  as_of_date: number | null;
  nav: number | null;
  premium_discount_percent: number | null;
  sec_yield_percent: number | null;
  ytd_return_percent: number | null;
  return_1y_percent: number | null;
  return_3y_percent: number | null;
  return_5y_percent: number | null;
  return_10y_percent: number | null;
  return_since_inception_percent: number | null;
  morningstar_rating: number | null;
  primary_benchmark: string | null;
  dividends_frequency: string | null;
  strategy: string | null;
  objective: string | null;
}

/** Reduce a shareClass.expenses / .fees block to the net & gross expense ratios (percent points). */
function expenseRatios(fd: Record<string, unknown>): {
  net: number | null;
  gross: number | null;
} {
  const sc = (fd.shareClass as Record<string, unknown> | null | undefined) ?? {};
  const exp = (sc.expenses as Record<string, unknown> | null | undefined) ?? {};
  const fees = (sc.fees as Record<string, unknown> | null | undefined) ?? {};
  return {
    net: num(exp.netExpense) ?? num(fees.expenseRatio) ?? num(fees.annualOperatingExpenses),
    gross: num(exp.grossExpense) ?? num(fees.annualOperatingExpenses),
  };
}

/** The primary benchmark name from product-data's benchmarks[0]. */
function primaryBenchmark(fd: Record<string, unknown>): string | null {
  const arr = fd.benchmarks;
  if (!Array.isArray(arr)) return null;
  for (const b of arr) {
    const name = str((b as Record<string, unknown>)?.benchmark != null
      ? ((b as Record<string, unknown>).benchmark as Record<string, unknown>)?.name
      : null);
    if (name) return decodeEntities(name);
  }
  return null;
}

/**
 * Merge the catalog identity row (nav, returns, yield, size) + the live product-data profile
 * (expense ratios, holdings count, benchmark, objective, strategy) into one details row. Both
 * inputs are optional and degrade to nulls.
 */
export function parseFundDetails(product: ProductRow | null, productData: unknown): FundDetailsRow {
  const p = product ?? ({} as Partial<ProductRow>);
  const fd = fundDataOf(productData);
  const exp = expenseRatios(fd);
  const aum = (fd.aum as Record<string, unknown> | null | undefined) ?? {};
  return {
    ticker: p.ticker ?? null,
    cusip: p.cusip ?? null,
    name: p.name ?? null,
    asset_class: p.asset_class ?? null,
    management_style: p.management_style ?? null,
    inception_date: p.inception_date ?? null,
    expense_ratio_percent: exp.net,
    gross_expense_ratio_percent: exp.gross,
    net_assets: num(aum.netAsset) ?? p.net_assets ?? null,
    num_holdings: num(fd.numberOfHoldings),
    as_of_date: dateSec(fd.numberOfHoldingsEffectiveDate) ?? dateSec(aum.date),
    nav: p.nav ?? null,
    premium_discount_percent: pct(fd.premiumDiscountPercentage) ?? p.premium_discount_percent ?? null,
    sec_yield_percent: p.sec_yield_percent ?? null,
    ytd_return_percent: p.ytd_return_percent ?? null,
    return_1y_percent: p.return_1y_percent ?? null,
    return_3y_percent: p.return_3y_percent ?? null,
    return_5y_percent: p.return_5y_percent ?? null,
    return_10y_percent: p.return_10y_percent ?? null,
    return_since_inception_percent: p.return_since_inception_percent ?? null,
    morningstar_rating: p.morningstar_rating ?? null,
    primary_benchmark: primaryBenchmark(fd),
    dividends_frequency: str(fd.dividendsFrequency),
    strategy: cleanText(fd.strategy),
    objective: cleanText(fd.objective),
  };
}

export async function fetchFundDetails(
  get: (url: string) => Promise<unknown>,
  product: ProductRow,
): Promise<FundDetailsRow> {
  const cusip = String(product.cusip ?? "");
  return parseFundDetails(product, await get(productDataUrl(cusip)));
}
