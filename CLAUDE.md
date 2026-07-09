# vgi-etf-jpmorgan — agent notes

A VGI (DuckDB) worker exposing **J.P. Morgan Asset Management** US ETF data as two base **tables** —
`products` (the catalog) and `holdings` (hive-partitioned by fund) — plus one table **function**,
`fund_details`, and the listed `holdings_scan` backing the holdings table. TypeScript, runs on Bun,
built on `@query-farm/vgi` (the TS SDK). Keyless — no secret type, no auth. Modeled EXACTLY on the
sibling `vgi-etf-invesco` worker (a JSON-BFF worker keyed by CUSIP with ticker→CUSIP resolution), which
is in turn modeled on `vgi-etf-ishares`.

## What differs from vgi-etf-invesco (read this first)

- **Only ONE callable function: `fund_details`.** J.P. Morgan's `product-data` object carries NO
  distribution history and NO NAV time series, so the `distributions` and `nav_history` functions
  from the Invesco sibling are **omitted** (do not invent them — the data isn't there). No date-arg
  functions at all, so there is no `dateArgToEpoch`.
- **Two endpoints, both under `https://am.jpmorgan.com/FundsMarketingHandler/`:**
  - `fund-explorer?fundType=etf&country=us&role=adv&language=en` → a JSON **array of 75 ETF
    objects** (NOT a Solr envelope). Backs `products` and the ticker→CUSIP resolver. Each object's
    `identifier` field is the **CUSIP**; `ticker`/`displayId` is the ticker.
  - `product-data?cusip=<CUSIP>&country=us&role=adv&language=en&userLoggedIn=false` → one big
    `{fundData:{…254 keys…}}` object. Backs `holdings` (from `fundData.dailyHoldingsAll.data`) and
    the product-data half of `fund_details`. A bad CUSIP returns `{fundData:null}` (handled → []).
- **The `version` token is optional.** The BFF accepts a `version=9.13_<digits>` cache-buster whose
  digits rotate, but **omitting it serves current data** (verified live). So the client sends NO
  version — there is no fragile token to keep fresh. This is why `client.ts` has no version logic.
- **Percent conversion differs.** J.P. Morgan reports returns / yields / premium-discount as
  **fractions** (`0.0777` = 7.77%), so the driver's `pct()` multiplies by 100 (rounded to 8 dp to
  shed float noise). BUT expense ratios, coupon rates, and holding weights already arrive in
  **percent points** (`0.35` = 0.35%, `1.71` = 1.71%), so those use `num()`, NOT `pct()`. Getting
  this wrong is the easiest bug — check the source field's magnitude.
- **Holdings coverage is FULL, not top-N.** `fundData.dailyHoldings` is the top-10 subset the site
  shows; `fundData.dailyHoldingsAll` is the complete position list (JEPI ~131, JPST ~794). The
  driver reads `dailyHoldingsAll` (falls back to `dailyHoldings` only if All is absent).
- **`products` has NO expense ratio.** The bulk fund-explorer feed doesn't carry it; the expense
  ratio lives only in per-fund `product-data` (`shareClass.expenses.netExpense` /
  `shareClass.fees.expenseRatio`), so it's a `fund_details` column, not a `products` column.
- **Holdings `cusip` comes from `securityId`.** The per-holding `securityCusip` field is usually
  null, but `securityId` carries the CUSIP, so the driver maps `securityCusip ?? securityId`.

## Base tables (`products`, `holdings`) — two layers: registry vs listing

Same mechanics as the siblings. Tables are wired via `SchemaDescriptor.tables` (`makeCatalog`'s
`tables: [...]`); each `TableDescriptor` has `function: <scan>` + `arguments: new Arguments([], new
Map())` and carries its docs on `tags`/`comment`/`columnComments`. Two INDEPENDENT layers matter:
- **FunctionRegistry** (`registry.register(scan)`) — the *dispatch* layer. Required for the table to
  be scannable.
- **catalog `schemas[].functions`** — the *listing* layer. Controls what shows as a callable `X()`
  function AND is where the extension discovers a scan's capabilities (e.g. `filter_pushdown`).

`products`: `productsScan` is **registered but NOT listed** → exposed only as the table (no
redundant `products()`), needs no pushdown. `holdings`: `holdingsScan` MUST be **listed**
(`functions: [...functions, holdingsScan]`) — an unlisted backing scan gets **no** `pushdown_filters`
(the extension can't see its `filter_pushdown` capability), so the `fund_ticker` partition filter
never reaches it. Hence a visible `holdings_scan()` is unavoidable; VGI311 is waived in
`vgi-lint.toml`.

## `holdings` — hive-partitioned by `fund_ticker`, CURRENT-only (no time travel)

Query `FROM jpmorgan.main.holdings WHERE fund_ticker = 'JEPI'` (fund selector); an **unfiltered
scan streams every fund** (one partition per fund). Mechanics (copied from vgi-etf-invesco):
- **Hive partitioning + streaming queue.** `holdingsScan` is a `partitionKind:
  "SINGLE_VALUE_PARTITIONS"` generator — `fund_ticker` is the partition key (annotated
  `vgi.partition_column` in `holdingsSchema`). `onInit` reads the pushed `fund_ticker` filter (or,
  absent one, the whole catalog), resolves each ticker to a CUSIP, and `queuePush`es one item per
  fund onto a `BoundStorage` queue keyed by the execution id. `process()` pops one fund per tick,
  fetches its holdings, and `out.emit`s a single partition batch tagged with `vgi_partition_values`
  (min==max==ticker). `maxWorkers` workers drain the same queue → work-stealing fan-out. `LIMIT`
  short-circuits the stream.
- **`filterPushdown: true`** on `holdingsScan` + LISTED → the extension pushes the filter in.
- **NO `supportsTimeTravel`.** product-data reports one effective date per fund; `as_of_date` is an
  output column (from `dailyHoldingsAll.effectiveDate`), NOT an AT coordinate.
- **`fund_ticker` is a SEPARATE column from `ticker`** — `ticker` is the CONSTITUENT's own ticker.
  The scan tags every row of a fund with `fundTicker` (the requested fund ticker, upper-cased).
- The CUSIP is used internally (resolveFund / product-data URL) and also surfaces as `products.cusip`
  and `holdings.cusip` (the constituent's). Constraints: `products` advisory PK `[cusip]`, `holdings`
  `notNull [fund_ticker]`. No cross-table FK (ticker/cusip recur with different meanings);
  VGI311/807/809 are waived in `vgi-lint.toml` with reasons.

## Architecture (keep this separation — identical to vgi-etf-invesco)

- **`src/jpmorgan.ts` — the pure driver.** URL builders + JSON→row parsers, plus thin `fetch*`
  orchestrators and `resolveFund` that take an injected `get(url) => Promise`. NO network, NO SDK
  import. This is what the unit tests exercise. All parsing is defensive: a missing key/array/object
  degrades to `[]` / `null` cells, never a throw. `resolveFund` returns `ProductRow | null` (null =
  not found) rather than throwing; `functions.ts` turns null into a typed `ArgumentValidationError`.
  Value coercers: `str`/`num` (with `-`/`N/A` sentinels → null), `pct` (fraction→percent points),
  `dateSec` (ISO → epoch seconds), `cleanText` (strip HTML + turn `~~` bullets into `; `).
- **`src/client.ts` — the only network module.** `makeJpmorganGet()` returns the real `get`: sets
  the browser User-Agent + `Referer: https://am.jpmorgan.com/`, retries transient 5xx, and memoizes
  the `/fund-explorer` catalog for 24 h (the same URL backs `products` and every ticker→CUSIP
  resolution). No dedicated unit test beyond the cache/retry logic; exercised live by the
  HTTP-transport E2E test.
- **`src/schema.ts` — typed Arrow schemas + batch builders.** Real typed columns
  (`Utf8`/`Float64`/`Int64`/`DateDay`). Every calendar date is a real Arrow **DATE** (`DateDay` →
  DuckDB `DATE`, no timezone; a DATE cell is a JS `Date` at UTC midnight, an Int64 cell is a
  `bigint`). Percent columns carry `_percent` and hold percent points. `resultColumnsSchema()` /
  `duckdbType()` / `partitionField` are copied verbatim from the sibling.
- **`src/functions.ts`** — three `defineTableFunction`s: `fund_details` (callable) plus
  `makeProductsScan` (unlisted backing) and `makeHoldingsScan` (listed, pushdown, partitioned).
  State is a `{done}` flag only (fully serializable → HTTP-transport safe).
- **`src/catalog.ts` / `src/worker.ts`** — catalog descriptor (no `secretTypes`) and the entry that
  wires the real client into the functions.

## Fund identifier (`fund` arg)

`resolveFund(get, fund)`: matches a ticker OR a raw CUSIP (case-insensitive) against the cached
catalog and returns the matching `ProductRow` (with its CUSIP + identity fields), or null. It does
NOT throw (keeps jpmorgan.ts SDK-free); `functions.ts` `resolveOrThrow` converts null into an
`ArgumentValidationError` with a "list tickers via products" hint. Ticker resolution is not cached
beyond the 24 h catalog memo — mind tight loops.

## Commands

```bash
bun install
bun test            # 38 tests: SDK-free driver + Arrow batch builders + live HTTP-transport E2E
bun run typecheck   # own-source only; scripts/typecheck.sh filters node_modules errors
./run_tests.sh      # haybarn SQLLogic E2E: worker under real DuckDB + community vgi ext (25 asserts)
```

`run_tests.sh` sets `VGI_TEST_WORKER=bin/vgi-etf-jpmorgan-worker` + `VGI_WORKER_CATALOG_NAME=jpmorgan`
and runs `test/sql/*.test`. The `.test` files are DESCRIBE-based schema asserts (bind-only → no
network → deterministic) plus a few live-invariant asserts that hit J.P. Morgan (fine for an egress
connector). CI runs this, the reusable `ts-ci.yml`, and a `vgi-lint` gate at `--fail-on info`
(currently 100/100).

Typecheck must be a `bash scripts/typecheck.sh` file (not an inline package.json pipeline) — `bun
run` uses Bun's shell, which mishandles the `grep -v node_modules` filter. Pin `typescript ^6.0.3`
(5.x descends into SDK `.ts` source and reports external errors).

## Gotchas / conventions

- Emit `bigint` (not `number`) for `Int64` columns via `batchFromColumns` (`bigOrNull`); date fields
  go through `dateSec` (→ epoch seconds) then `dateOrNull`.
- `noUncheckedIndexedAccess` is on: read parallel-array / possibly-absent cells defensively.
- **`pct()` vs `num()` is the #1 correctness trap** — returns/yields/premium-discount are FRACTIONS
  (use `pct`); expense ratios, coupon rates, and holding weights are already PERCENT POINTS (use
  `num`). Verify against the live field magnitude, not intuition.
- vgi-lint rules that must stay satisfied: catalog/schema descriptions must NOT enumerate the
  worker's own functions (VGI173 — describe purpose/concepts); argument docs must NOT restate the
  data type (VGI313 — the `fund` doc says "portfolio ticker or CUSIP", never "numeric"); every
  function needs an agent test task (VGI520 — all covered in `catalog.ts` `vgi.agent_test_tasks`).
- Don't add a secret type; this worker is keyless by design.
- Don't add `distributions` / `nav_history`; the data plane doesn't carry those series.

## DuckDB (manual)

```sql
LOAD vgi;
ATTACH 'jpmorgan' AS jpm (TYPE vgi, LOCATION '/path/to/vgi-etf-jpmorgan/bin/vgi-etf-jpmorgan-worker');
SELECT ticker, net_assets FROM jpm.products ORDER BY net_assets DESC LIMIT 10;
SELECT ticker, name, weight_percent FROM jpm.holdings WHERE fund_ticker = 'JEPI' ORDER BY weight_percent DESC LIMIT 10;
SELECT ticker, primary_benchmark, expense_ratio_percent FROM jpm.fund_details('JEPI');
```
