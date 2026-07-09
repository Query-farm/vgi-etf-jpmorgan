# vgi-etf-jpmorgan

A [VGI](https://query.farm) worker that exposes **J.P. Morgan Asset Management** US ETF data as
DuckDB tables and a table function — the ETF product catalog, a fund-partitioned holdings table,
and a wide per-fund characteristics snapshot.

| Object | What it returns | J.P. Morgan source |
| --- | --- | --- |
| `jpmorgan.products` (table) | Every US ETF with key facts, one row per fund | `/fund-explorer` catalog |
| `jpmorgan.holdings` (table) | Detailed current holdings (full position list), partitioned by fund_ticker | `/product-data?cusip=…` → `dailyHoldingsAll` |
| `jpmorgan.fund_details(fund)` | Wide one-row characteristics snapshot | catalog identity + `/product-data?cusip=…` |

Everything rides J.P. Morgan's public JSON "BFF" (backend-for-frontend) on
`am.jpmorgan.com/FundsMarketingHandler/` — there is no secret to create and no login. Funds are
identified by their exchange **ticker** (e.g. `JEPI`); the per-fund `product-data` resource is keyed
by **CUSIP**, so the fund-scoped function resolves ticker→CUSIP via one cached catalog lookup.

Two conventions to know:
- **Dates are real `DATE` columns** (no timezone) — compare them directly, e.g.
  `WHERE maturity_date >= DATE '2027-01-01'`.
- **Percent columns carry a `_percent` suffix and hold percent points**: `sec_yield_percent` = 8.2
  means 8.2%; `weight_percent` = 1.71 means 1.71% (weights sum to ~100); `expense_ratio_percent` =
  0.35 means 0.35%. J.P. Morgan reports returns/yields as fractions internally; the driver converts
  them to percent points.

> **Holdings are current-only.** J.P. Morgan publishes a single effective date per fund, so the
> `holdings` table has **no time travel** — the `as_of_date` column reflects the reported effective
> date. The BFF also carries no distribution or NAV time series, so (unlike the sibling Invesco
> worker) there are no `distributions` / `nav_history` functions.

> **Coverage note.** The `holdings` table returns the **full published position list** per fund
> (from `dailyHoldingsAll`), not a top-N subset. The bulk `products` feed does **not** carry the
> expense ratio; get it from `fund_details`.

> **Status:** initial build. Unit tests (SDK-free driver + Arrow batch builders), own-source
> typecheck, a live HTTP-transport smoke test, the haybarn SQLLogic E2E suite against a real DuckDB
> + the community `vgi` extension, and a `vgi-lint` metadata gate at 100/100 all pass.

## Install / attach

### Option A — prebuilt binary (recommended)

Each release ships a self-contained executable per platform, so the host needs **neither Bun nor
`node_modules`**. Archives are named `vgi-etf-jpmorgan-<tag>-<platform>.tar.gz` for `linux_amd64`,
`linux_arm64`, `osx_amd64`, `osx_arm64`, and `windows_amd64`, each with a SHA256, a keyless
**cosign** signature, and a **SLSA** build-provenance attestation.

```bash
tar xzf vgi-etf-jpmorgan-v0.1.0-osx_arm64.tar.gz     # → vgi-etf-jpmorgan-worker
```

```sql
LOAD vgi;
ATTACH 'jpmorgan' AS jpmorgan (TYPE vgi, LOCATION '/path/to/vgi-etf-jpmorgan-worker');
```

### Option B — from source (Bun)

For development or the latest `main`, run the worker on [Bun](https://bun.sh):

```bash
bun install
```

```sql
LOAD vgi;
ATTACH 'jpmorgan' AS jpmorgan (TYPE vgi, LOCATION '/path/to/vgi-etf-jpmorgan/bin/vgi-etf-jpmorgan-worker');
```

`bin/vgi-etf-jpmorgan-worker` is a small wrapper that launches `src/worker.ts` under Bun.

### Option C — container image (ghcr.io)

A multi-arch (linux/amd64 + linux/arm64), cosign-signed image is published to
`ghcr.io/query-farm/vgi-etf-jpmorgan` on every release — no local Bun or worker binary needed.
Attach it directly over the VGI container transport:

```sql
LOAD vgi;
ATTACH 'jpmorgan' AS jpmorgan (TYPE vgi, LOCATION 'oci://ghcr.io/query-farm/vgi-etf-jpmorgan:latest');
```

Or run the HTTP transport yourself and attach that:

```bash
docker run --rm -p 8000:8000 ghcr.io/query-farm/vgi-etf-jpmorgan:latest   # serves /health + the VGI RPC on :8000
```

```sql
LOAD vgi;
ATTACH 'jpmorgan' AS jpmorgan (TYPE vgi, LOCATION 'http://localhost:8000');
```

`:latest` always tracks the newest release.

## Usage

### products — the ETF catalog (a base table)

`products` is a plain **table** — no arguments, no parentheses. It returns the whole ETF lineup;
filter with `WHERE`.

```sql
-- Largest J.P. Morgan ETFs by assets:
SELECT ticker, name, net_assets
FROM jpmorgan.products
ORDER BY net_assets DESC
LIMIT 10;

-- Fixed-income ETFs:
SELECT ticker, name, sec_yield_percent
FROM jpmorgan.products
WHERE asset_class LIKE 'Fixed Income%'
ORDER BY name;

-- Look up one fund by ticker:
SELECT ticker, name, nav, sec_yield_percent
FROM jpmorgan.products
WHERE ticker = 'JEPI';
```

Filter on `ticker`, `asset_class` (`'U.S. Equity'`, `'Fixed Income Taxable'`, `'International
Equity'`, …), `management_style` (`'Active'`/`'Passive'`), etc. Columns include `ticker`, `cusip`,
`name`, `display_name`, `asset_class`, `management_style`, `fund_type_code`, `currency`,
`morningstar_rating`, `inception_date` (DATE), `net_assets`, `nav`, `nav_date` (DATE),
`market_price`, `premium_discount_percent`, `sec_yield_percent`, the annualized `*_return_percent`
series, and `kiid_url`. All `*_percent` columns are in percent points. The expense ratio is **not**
in this bulk feed — use `fund_details`.

### holdings — a fund-partitioned table (current-only)

`holdings` is a **table hive-partitioned by `fund_ticker`** (the fund's ticker). Filter
`fund_ticker` to pick funds, or scan without a filter to stream **every** fund's holdings (one
partition per fund — 75 funds, so prefer a filter). Each fund returns its **full** position list.

```sql
-- Top 10 current holdings of JEPI (already weight-ordered):
SELECT ticker, name, weight_percent, market_value
FROM jpmorgan.holdings
WHERE fund_ticker = 'JEPI'
ORDER BY weight_percent DESC
LIMIT 10;

-- Several funds at once (partition fan-out):
SELECT fund_ticker, ticker, weight_percent
FROM jpmorgan.holdings
WHERE fund_ticker IN ('JEPI', 'JPST');

-- Every fund at once (streams all partitions — slow; each fund is a partition):
SELECT fund_ticker, count(*) AS n
FROM jpmorgan.holdings
GROUP BY fund_ticker;

-- A bond fund also fills coupon / maturity / rating:
SELECT name, coupon_percent, maturity_date, rating, weight_percent
FROM jpmorgan.holdings
WHERE fund_ticker = 'JPST'
LIMIT 5;
```

`fund_ticker` is the **fund's** ticker and the hive partition key — distinct from the `ticker`
column (each row's own constituent ticker). J.P. Morgan reports a single effective date per fund
(the `as_of_date` column); there is **no time travel**. Rows come back **weight-descending**. Join
`holdings.fund_ticker` to `products.ticker` for fund-level facts. Columns: `fund_ticker`,
`as_of_date` (DATE), `name`, `ticker`, `cusip`, `weight_percent`, `market_value`, `shares`,
`sec_type`, `sector`, `industry`, `country`, `currency`, plus the fixed-income-leaning
`coupon_percent`, `maturity_date` (DATE), `rating`, and `yield_percent`.

> A backing `holdings_scan()` function is also exposed (it's what the table scans, and it's what
> lets DuckDB push the `fund_ticker` filter) — prefer the `holdings` table.

### fund_details — one-row characteristics snapshot

```sql
SELECT ticker, primary_benchmark, expense_ratio_percent, sec_yield_percent, morningstar_rating
FROM jpmorgan.fund_details('JEPI');
```

Adds facts beyond `products`: net & gross expense ratios, net assets, holdings count, premium/
discount, the primary benchmark, and the fund's objective and strategy prose.

```sql
SELECT ticker, net_assets, num_holdings, return_1y_percent, return_since_inception_percent
FROM jpmorgan.fund_details('JEPI');
```

## Development

```bash
bun install
bun test            # unit tests (SDK-free driver + Arrow batch builders + live HTTP transport)
bun run typecheck   # own-source typecheck (see scripts/typecheck.sh)
./run_tests.sh      # haybarn SQLLogic E2E under a real DuckDB + the community vgi extension
```

The E2E suite needs the haybarn runner and the vgi extension, once:

```bash
uv tool install haybarn-unittest
echo "INSTALL vgi FROM community;" | uvx haybarn-cli
```

Metadata quality is graded by [`vgi-lint`](https://github.com/Query-farm/vgi-lint-check); CI runs it
as a gate at 100/100. Locally:

```bash
uvx --prerelease allow --from vgi-lint-check vgi-lint bin/vgi-etf-jpmorgan-worker --fail-on info
```

The pure request/response logic lives in `src/jpmorgan.ts` and is fully unit-tested against an
in-process fake (`test/fake-jpmorgan.ts`) — no network. The single module that touches the network
is `src/client.ts` (it sets the browser-like User-Agent + Referer and retries transient 5xx); it is
verified live rather than in the unit suite.

## Layout

```
src/jpmorgan.ts   Pure driver: URL builders + JSON parsers + fetch orchestrators (no network, no SDK)
src/client.ts     Real fetch client (browser User-Agent + Referer; 5xx retry; keyless)
src/schema.ts     Typed Arrow output schemas + row→batch builders
src/functions.ts  The table-function / backing-scan definitions
src/catalog.ts    The `jpmorgan` catalog descriptor (no secret type)
src/worker.ts     Worker entry: wires the real client into the functions
bin/…-worker      Launch wrapper (bun run src/worker.ts) for DuckDB ATTACH
```

## Data source & terms

Data comes from J.P. Morgan Asset Management's public product API
(`am.jpmorgan.com/FundsMarketingHandler/`: the `/fund-explorer` catalog and the per-fund
`/product-data?cusip=…` resource). It is provided for personal, informational use; consult J.P.
Morgan's terms before any redistribution or commercial use. This worker is not affiliated with or
endorsed by JPMorgan Chase & Co. or its affiliates.

## License

MIT — Copyright 2026 Query Farm LLC · https://query.farm
