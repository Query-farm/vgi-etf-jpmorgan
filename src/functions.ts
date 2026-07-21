// The VGI table functions and base-table backing scans: the `products` and `holdings` tables
// (backing scans) plus one callable function — fund_details. All keyless, all single-shot
// snapshots — function state is just a `done` flag (fully serializable; no socket / batch / Date),
// so the HTTP transport can round-trip it. The J.P. Morgan `get` client is injected so worker.ts
// wires the real fetch and tests wire a fake.
//
// NOTE — J.P. Morgan holdings are CURRENT-only: the holdings scan is hive-partitioned by
// fund_ticker but declares NO time travel (product-data reports one effective date; `as_of_date` is
// an output column). product-data carries no distribution / NAV time series, so there are no
// distributions / nav_history functions.

import {
  defineTableFunction,
  ArgumentValidationError,
  batchFromColumns,
  serializeBatch,
  deserializeFilters,
  buildJoinKeysLookup,
  DEFAULT_MAX_WORKERS,
  type OutputCollector,
} from "@query-farm/vgi";
import { Schema, Field, Utf8 } from "@query-farm/apache-arrow";
import {
  fetchProducts,
  fetchHoldings,
  fetchFundDetails,
  resolveFund,
  type ProductRow,
} from "./jpmorgan.js";
import {
  productsSchema,
  productsBatch,
  holdingsSchema,
  holdingsBatch,
  fundDetailsSchema,
  fundDetailsBatch,
  resultColumnsSchema,
} from "./schema.js";

/** The injected HTTP getter: URL in, parsed JSON out. */
export type JpmorganGet = (url: string) => Promise<unknown>;

// Per-column descriptions for the `vgi.result_columns_schema` tag (JSON [{name,type,description}],
// generated from each Arrow schema via resultColumnsSchema).

const HOLDINGS_SCAN_DESCS: Record<string, string> = {
  fund_ticker: "The fund's ticker — the partition filter (e.g. JEPI).",
  as_of_date: "The effective date J.P. Morgan reports for these holdings.",
  name: "Constituent / security description.",
  ticker: "Constituent ticker (the holding's own ticker; distinct from fund_ticker).",
  cusip: "Constituent CUSIP / security id.",
  weight_percent: "Percent of the fund's market value, 0–100 (1.71 = 1.71%).",
  market_value: "Market value held, in the fund's currency.",
  shares: "Quantity held, as a count of shares/units (or par for bonds).",
  sec_type: "Security type classification (e.g. DOMESTIC COMMON STOCK, TREASURY NOTES).",
  sector: "GICS-style sector (equity positions).",
  industry: "Industry classification (equity positions).",
  country: "Country of the position.",
  currency: "Currency of the position.",
  coupon_percent: "Coupon rate, percent points (fixed income only).",
  maturity_date: "Final legal maturity date (fixed income only).",
  rating: "S&P / Moody's / Fitch rating (fixed income only).",
  yield_percent: "Security yield, percent points (when reported).",
};

const FUND_DETAILS_DESCS: Record<string, string> = {
  ticker: "Exchange ticker.",
  cusip: "Fund CUSIP.",
  name: "Fund name.",
  asset_class: "Asset class (U.S. Equity, Fixed Income Taxable, International Equity, …).",
  management_style: "Active or Passive.",
  inception_date: "Fund inception date.",
  expense_ratio_percent: "Net expense ratio, percent points (0.35 = 0.35%).",
  gross_expense_ratio_percent: "Gross expense ratio, percent points.",
  net_assets: "Total net assets (AUM), in the fund's currency.",
  num_holdings: "Number of holdings.",
  as_of_date: "As-of date for the holdings-count / AUM snapshot.",
  nav: "Latest net asset value per share.",
  premium_discount_percent: "Market price premium or discount to NAV, percent points.",
  sec_yield_percent: "30-day SEC yield, percent points.",
  ytd_return_percent: "Year-to-date NAV return, percent points.",
  return_1y_percent: "Annualized 1-year NAV return, percent points.",
  return_3y_percent: "Annualized 3-year NAV return, percent points.",
  return_5y_percent: "Annualized 5-year NAV return, percent points.",
  return_10y_percent: "Annualized 10-year NAV return, percent points.",
  return_since_inception_percent: "Annualized since-inception NAV return, percent points.",
  morningstar_rating: "Morningstar overall star rating (1–5; 0 when unrated).",
  primary_benchmark: "Primary benchmark name.",
  dividends_frequency: "Dividend/distribution frequency code (e.g. MDEC = monthly).",
  strategy: "Investment strategy summary (plain text).",
  objective: "Investment objective (plain text).",
};

interface DoneState {
  done: boolean;
}

/** Guard a required string argument; returns the trimmed value or throws ArgumentValidationError. */
function required(fn: string, name: string, v: unknown): string {
  if (v == null || String(v).trim() === "") {
    throw new ArgumentValidationError(`${fn}: ${name} is required`);
  }
  return String(v).trim();
}

/** Resolve a `fund` arg to its catalog row, raising a typed, discoverable error when it misses. */
async function resolveOrThrow(fn: string, get: JpmorganGet, fund: string): Promise<ProductRow> {
  const row = await resolveFund(get, fund);
  if (row == null || !row.cusip) {
    throw new ArgumentValidationError(
      `${fn}: could not resolve fund '${fund}'. Pass a J.P. Morgan ETF ticker (e.g. 'JEPI'); ` +
        `list valid tickers with SELECT ticker FROM jpmorgan.main.products.`,
    );
  }
  return row;
}

// ── holdings queue plumbing (BoundStorage work queue + hive partition metadata) ──
//
// The holdings scan streams one fund per partition. `onInit` seeds a BoundStorage queue with the
// target funds (one item each); each `process()` tick pops a fund, fetches its holdings, and emits
// one SINGLE_VALUE partition. Multiple parallel workers drain the same execution-scoped queue, so
// the fan-out is naturally work-stealing and bounded by maxWorkers.

/** A queued fund: its ticker (the partition value) and its CUSIP (the resource key). */
interface FundItem {
  ticker: string;
  cusip: string;
}
const encodeFund = (item: FundItem): Uint8Array => new TextEncoder().encode(JSON.stringify(item));
const decodeFund = (bytes: Uint8Array): FundItem => JSON.parse(new TextDecoder().decode(bytes));

/** Plain (non-annotated) field used to build the partition-values (min,max) batch. */
const FUND_TICKER_FIELD = new Field("fund_ticker", new Utf8(), true);

const b64encode = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/**
 * Build the `vgi_partition_values#b64` batch metadata for a SINGLE_VALUE partition: a 2-row
 * (min,max) Arrow batch over fund_ticker where min == max == the fund's ticker.
 */
function partitionValues(ticker: string): Map<string, string> {
  const batch = batchFromColumns({ fund_ticker: [ticker, ticker] }, new Schema([FUND_TICKER_FIELD]));
  return new Map([["vgi_partition_values#b64", b64encode(serializeBatch(batch))]]);
}

// ── products (backing scan for the products TABLE) ──────────────────────────────
//
// `products` is exposed as a real base TABLE (see catalog.ts `tables`), not a table function, so
// users query `FROM jpmorgan.products` (no parens) and filter with WHERE — no arguments. This
// zero-arg scan is registered only for scan dispatch (it is NOT listed among the catalog's callable
// functions). It returns the J.P. Morgan ETF catalog; a WHERE on ticker / asset_class narrows it.

export function makeProductsScan(get: JpmorganGet) {
  const schema = productsSchema();
  return defineTableFunction<Record<string, never>, DoneState>({
    name: "products",
    description: "J.P. Morgan US ETF catalog — backing scan for the products table.",
    args: {},
    onBind: () => ({ outputSchema: schema }),
    initialState: () => ({ done: false }),
    process: async (_p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const rows = await fetchProducts(get);
      out.emit(productsBatch(schema, rows));
      state.done = true;
    },
  });
}

// ── holdings (backing scan for the holdings TABLE) ─────────────────────────────
//
// `holdings` is exposed as a base TABLE (see catalog.ts), HIVE-PARTITIONED on `fund_ticker` (the
// fund's ticker — distinct from the constituent `ticker` column). J.P. Morgan holdings are
// CURRENT-only, so there is NO time travel:
//   SELECT * FROM jpmorgan.main.holdings WHERE fund_ticker = 'JEPI';
//   SELECT * FROM jpmorgan.main.holdings WHERE fund_ticker IN ('JEPI','JPST'); -- fan-out per partition
//   SELECT * FROM jpmorgan.main.holdings;                                       -- ALL funds (every partition)
//
// Each fund is one SINGLE_VALUE partition. The scan is a streaming, queue-backed generator:
//   • onInit (runs once on the coordinator) reads the pushed fund_ticker filter — or, absent one,
//     the ENTIRE ETF catalog — resolves each ticker to its CUSIP and pushes one item per fund onto
//     a BoundStorage work queue keyed by the execution id.
//   • process() pops one fund per tick, fetches its current holdings (by CUSIP), and emits a single
//     partition batch (tagged with vgi_partition_values so DuckDB sees fund_ticker as the key). A
//     fund whose product-data errors is skipped, not fatal.
// Multiple parallel workers drain the same queue, so the all-funds fan-out is work-stealing and
// bounded by maxWorkers. filterPushdown + being LISTED is what lets DuckDB push fund_ticker here.

export function makeHoldingsScan(get: JpmorganGet) {
  const schema = holdingsSchema();
  return defineTableFunction<Record<string, never>, Record<string, never>>({
    // Named to MATCH the `holdings` table it backs (not "holdings_scan"): a table function and a
    // table can share a qualified name in DuckDB (the function is called with parens, the table
    // without), and naming them alike is what lets the metadata linter see this listed, parameterless
    // scan as the browsable `holdings` table rather than an orphan zero-arg function (VGI311).
    name: "holdings",
    description:
      "Backing scan for the holdings table — prefer the `holdings` table. Detailed current fund " +
      "holdings, hive-partitioned by fund_ticker: filter WHERE fund_ticker = 'JEPI' (or " +
      "fund_ticker IN (…)) for specific funds, or scan with no filter to stream every fund's " +
      "holdings. weight_percent is in percent points; bond funds also fill coupon/maturity/rating.",
    args: {},
    // filterPushdown MUST be declared AND this function MUST be listed in the catalog so the DuckDB
    // extension can discover the capability and push the fund_ticker filter into the table scan.
    // Each fund is one SINGLE_VALUE partition (fund_ticker is the hive partition key).
    filterPushdown: true,
    partitionKind: "SINGLE_VALUE_PARTITIONS",
    maxWorkers: DEFAULT_MAX_WORKERS,
    onBind: () => ({ outputSchema: schema }),
    // Seed the work queue (once, on the coordinator): one item per target fund.
    onInit: async ({ initCall, executionId, storage }) => {
      // Pushed fund_ticker value(s) from WHERE (= or IN), if any. Absent → scan all funds.
      const joinKeys = buildJoinKeysLookup(initCall.join_keys);
      const filters = initCall.pushdown_filters
        ? deserializeFilters(initCall.pushdown_filters, joinKeys)
        : undefined;
      const requested = (filters?.getColumnValues("fund_ticker") ?? []).map((t) =>
        String(t).toUpperCase(),
      );
      // Build the fund set from the (cached) ETF catalog. One fetch either way.
      const products = await fetchProducts(get);
      const byTicker = new Map<string, FundItem>(
        products
          .filter((r) => r.ticker && r.cusip)
          .map((r) => [
            String(r.ticker).toUpperCase(),
            { ticker: String(r.ticker).toUpperCase(), cusip: String(r.cusip) },
          ]),
      );
      const targets: FundItem[] =
        requested.length > 0
          ? requested.map((t) => byTicker.get(t)).filter((x): x is FundItem => x != null)
          : [...byTicker.values()];
      await storage.queuePush(targets.map(encodeFund));
      return { max_workers: DEFAULT_MAX_WORKERS, execution_id: executionId, opaque_data: null };
    },
    initialState: () => ({}),
    process: async (p, _state, out: OutputCollector) => {
      // Pop one fund per tick; emit exactly one partition. Skip empty/erroring partitions and pop
      // the next. Queue empty → end of scan.
      for (;;) {
        const item = await p.storage!.queuePop();
        if (item === null) {
          out.finish();
          return;
        }
        const fund = decodeFund(item);
        let rows;
        try {
          rows = await fetchHoldings(get, fund.cusip, fund.ticker);
        } catch {
          // A fund whose product-data errors is skipped, not fatal (all-funds scans).
          continue;
        }
        if (rows.length === 0) continue;
        out.emit(holdingsBatch(schema, rows), partitionValues(fund.ticker));
        return;
      }
    },
    examples: [
      { sql: "SELECT ticker, name, weight_percent FROM jpmorgan.main.holdings() WHERE fund_ticker = 'JEPI' ORDER BY weight_percent DESC LIMIT 10", description: "Top 10 holdings of JEPI via the backing scan" },
      { sql: "SELECT fund_ticker, count(*) FROM jpmorgan.main.holdings() WHERE fund_ticker IN ('JEPI', 'JPST') GROUP BY fund_ticker", description: "Two partitions at once (fan-out)" },
    ],
    tags: {
      "vgi.category": "holdings",
      "vgi.doc_llm":
        "The backing scan for the `holdings` table. Prefer querying the `holdings` table. " +
        "Hive-partitioned by fund_ticker (the fund's ticker, distinct from the constituent " +
        "`ticker` column): filter WHERE fund_ticker = '…' (or fund_ticker IN (…)) for specific " +
        "funds, or scan with no filter to stream every fund (75 partitions — slow). Holdings are " +
        "the FULL position list and current-only (no historical as-of). weight_percent is in " +
        "percent points (1.71 = 1.71%); bond funds also fill coupon/maturity/rating.",
      "vgi.doc_md":
        "## holdings() backing scan\n\n" +
        "The backing scan for the **`holdings` table** — prefer the table. Hive-partitioned by " +
        "`fund_ticker`: filter `WHERE fund_ticker = 'JEPI'` for one fund, or scan with no filter to " +
        "stream every fund (see the example queries). `fund_ticker` is distinct from the " +
        "constituent `ticker` column. Holdings are the full position list and current-only (no " +
        "historical as-of).",
      // Carry the same examples through the description-preserving example_queries tag: the VGI
      // extension re-surfaces Meta.examples into duckdb_functions().examples as a bare SQL VARCHAR[]
      // (descriptions dropped), so without this the descriptions are invisible to vgi-lint (VGI515).
      // Byte-identical SQL to the `examples:` above; the linter dedups by normalized SQL.
      "vgi.example_queries": JSON.stringify([
        { description: "Top 10 holdings of JEPI via the backing scan", sql: "SELECT ticker, name, weight_percent FROM jpmorgan.main.holdings() WHERE fund_ticker = 'JEPI' ORDER BY weight_percent DESC LIMIT 10" },
        { description: "Two partitions at once (fan-out)", sql: "SELECT fund_ticker, count(*) FROM jpmorgan.main.holdings() WHERE fund_ticker IN ('JEPI', 'JPST') GROUP BY fund_ticker" },
      ]),
      "vgi.result_columns_schema": resultColumnsSchema(holdingsSchema(), HOLDINGS_SCAN_DESCS),
    },
  });
}

// ── fund_details ──────────────────────────────────────────────────────────────

interface FundArgs {
  fund: string;
}

const FUND_ARG_DOC =
  "The fund to look up, given as an exchange " +
  "ticker like 'JEPI' (a raw CUSIP also works). Required, first positional argument.";

export function makeFundDetailsFunction(get: JpmorganGet) {
  const schema = fundDetailsSchema();
  return defineTableFunction<FundArgs, DoneState>({
    name: "fund_details",
    description:
      "A wide one-row snapshot of a single fund's key facts: identifiers, expense ratios, net " +
      "assets, NAV, premium/discount, 30-day SEC yield, annualized returns, Morningstar rating, " +
      "the primary benchmark, and the fund's objective and strategy prose. `fund` is a ticker " +
      "like JEPI.",
    args: { fund: new Utf8() },
    argDocs: { fund: FUND_ARG_DOC },
    onBind: (p) => {
      required("fund_details", "fund", p.args.fund);
      return { outputSchema: schema };
    },
    initialState: () => ({ done: false }),
    process: async (p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const product = await resolveOrThrow("fund_details", get, String(p.args.fund));
      const row = await fetchFundDetails(get, product);
      out.emit(fundDetailsBatch(schema, [row]));
      state.done = true;
    },
    examples: [
      { sql: "SELECT ticker, primary_benchmark, expense_ratio_percent, sec_yield_percent FROM jpmorgan.main.fund_details('JEPI')", description: "Key characteristics for JEPI" },
      { sql: "SELECT ticker, net_assets, num_holdings, morningstar_rating FROM jpmorgan.main.fund_details('JEPI')", description: "Size, holdings count, and Morningstar rating" },
      { sql: "SELECT return_1y_percent, return_since_inception_percent FROM jpmorgan.main.fund_details('JEPI')", description: "1-year and since-inception NAV returns" },
    ],
    tags: {
      "vgi.category": "catalog",
      "vgi.doc_llm":
        "One-row detail snapshot for a fund: identifiers, net & gross expense ratios, net assets, " +
        "holdings count, latest NAV, premium/discount, 30-day SEC yield, annualized returns " +
        "(ytd/1y/3y/5y/10y/since inception), Morningstar rating, the primary benchmark, and the " +
        "fund's objective and strategy prose. Percent columns are in percent points. Deeper than " +
        "the products row for a single fund.",
      "vgi.doc_md":
        "## fund_details\n\n" +
        "A wide one-row snapshot of a fund's key facts — the details beyond what `products` carries " +
        "(net & gross expense ratios, holdings count, primary benchmark, objective and strategy " +
        "prose). Percent columns are in percent points.\n\n" +
        "It returns exactly one row; for the whole lineup use `products` (see the example queries).",
      // Carry the same examples through the description-preserving example_queries tag: the VGI
      // extension re-surfaces Meta.examples into duckdb_functions().examples as a bare SQL VARCHAR[]
      // (descriptions dropped), so without this the descriptions are invisible to vgi-lint (VGI515).
      // Byte-identical SQL to the `examples:` above; the linter dedups by normalized SQL.
      "vgi.example_queries": JSON.stringify([
        { description: "Key characteristics for JEPI", sql: "SELECT ticker, primary_benchmark, expense_ratio_percent, sec_yield_percent FROM jpmorgan.main.fund_details('JEPI')" },
        { description: "Size, holdings count, and Morningstar rating", sql: "SELECT ticker, net_assets, num_holdings, morningstar_rating FROM jpmorgan.main.fund_details('JEPI')" },
        { description: "1-year and since-inception NAV returns", sql: "SELECT return_1y_percent, return_since_inception_percent FROM jpmorgan.main.fund_details('JEPI')" },
      ]),
      "vgi.result_columns_schema": resultColumnsSchema(fundDetailsSchema(), FUND_DETAILS_DESCS),
    },
  });
}
