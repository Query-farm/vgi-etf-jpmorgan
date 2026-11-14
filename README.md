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

## Quick start

Every [GitHub release](https://github.com/Query-farm/vgi-etf-jpmorgan/releases) ships a prebuilt worker binary. The `vgi` extension downloads the one for your platform, checks its SHA-256 and caches it, so there is nothing to install besides DuckDB:

```sql
INSTALL vgi FROM community;
LOAD vgi;

ATTACH 'jpmorgan' AS jpmorgan (TYPE vgi, LOCATION 'github-auto://Query-farm/vgi-etf-jpmorgan@v0.4.0');

-- The largest J.P. Morgan ETFs by assets
SELECT ticker, name, net_assets FROM jpmorgan.main.products ORDER BY net_assets DESC LIMIT 5;

-- The top holdings of the JPMorgan Equity Premium Income ETF
SELECT ticker, name, weight_percent FROM jpmorgan.main.holdings WHERE fund_ticker = 'JEPI' ORDER BY weight_percent DESC LIMIT 5;
```

Prebuilt binaries cover macOS (Apple silicon), Linux (x86-64 and arm64). `github-auto://` needs an explicit release tag; change `@v0.4.0` to move to a newer release.

### Other ways to run it

- **Docker** (the image bundles the worker; needs a container runtime):

  ```sql
  ATTACH 'jpmorgan' AS jpmorgan (TYPE vgi, LOCATION 'docker://ghcr.io/query-farm/vgi-etf-jpmorgan:0.4.0');
  ```

- **Manual download.** Download the archive for your platform from the [releases page](https://github.com/Query-farm/vgi-etf-jpmorgan/releases), verify it against its `.sha256` file (a cosign `.cosign.bundle` is published alongside), unpack it, and set `LOCATION` to the path of the extracted worker executable.

- **HTTP server.** Run the image's HTTP transport yourself and attach it by URL:

  ```bash
  docker run --rm -p 8000:8000 ghcr.io/query-farm/vgi-etf-jpmorgan:0.4.0   # serves /health + the VGI RPC on :8000
  ```

  ```sql
  ATTACH 'jpmorgan' AS jpmorgan (TYPE vgi, LOCATION 'http://localhost:8000');
  ```

### Build from source

For development or the latest `main`, run the worker on [Bun](https://bun.sh):

```bash
bun install
```

```sql
LOAD vgi;
ATTACH 'jpmorgan' AS jpmorgan (TYPE vgi, LOCATION '/path/to/vgi-etf-jpmorgan/bin/vgi-etf-jpmorgan-worker');
```

`bin/vgi-etf-jpmorgan-worker` is a small wrapper that launches `src/worker.ts` under Bun.

Tests, typecheck and the E2E suite are described under [Development](#development).

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

Join `holdings` to `products` to screen funds by what they hold. A join on `fund_ticker` does not
narrow the holdings scan, so this streams every fund's partition (a few seconds); the constituent
`ticker` filter is applied in the scan:

```sql
-- Which J.P. Morgan U.S. equity ETFs hold Apple, largest weight first:
SELECT p.ticker AS fund_ticker, p.name AS fund_name, h.weight_percent, h.market_value
FROM jpmorgan.products p
JOIN jpmorgan.holdings h ON h.fund_ticker = p.ticker
WHERE p.asset_class = 'U.S. Equity' AND h.ticker = 'AAPL'
ORDER BY h.weight_percent DESC, p.ticker;
```

> A backing `holdings()` scan function is also exposed under the same qualified name as the
> `holdings` table it backs (a table function and a table can share a name — the function is called
> with parens). It's what the table scans, and it's what lets DuckDB push the `fund_ticker` filter —
> prefer the `holdings` table.

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
uv tool install --prerelease allow 'haybarn-unittest>=2.0.0rc11,<2.1'
echo "INSTALL vgi FROM community;" | uvx --prerelease allow --from 'haybarn-cli>=2.0.0rc11,<2.1' haybarn-cli
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
