// The `jpmorgan` catalog descriptor + its metadata tags (the vgi.* discovery/doc channels
// vgi-lint grades). J.P. Morgan's public fund-explorer / product-data endpoints are KEYLESS, so
// there is NO secret type here.
//
// Tag shapes follow vgi-lint's TAGS.md: JSON-valued tags (keywords/categories/
// executable_examples/agent_test_tasks) are JSON strings; all example SQL is catalog-qualified
// (jpmorgan.main.<fn>) so it binds/runs when the catalog is attached.

import type { CatalogDescriptor, VgiFunction } from "@query-farm/vgi";
import { Arguments } from "@query-farm/vgi";
import { productsSchema, holdingsSchema, resultColumnsSchema } from "./schema.js";

const REPO = "https://github.com/Query-farm/vgi-etf-jpmorgan";
const ISSUES = `${REPO}/issues`;

/** Per-column comments for the products table (surface as Arrow field metadata). */
const PRODUCTS_COLUMN_COMMENTS: Record<string, string> = {
  ticker: "Exchange ticker (e.g. JEPI).",
  cusip: "CUSIP identifier (the key J.P. Morgan's product-data resource uses).",
  name: "Full fund name, e.g. 'JPMorgan Equity Premium Income ETF'.",
  display_name: "Short marketing name, e.g. 'Equity Premium Income ETF'.",
  asset_class: "Asset class (U.S. Equity, Fixed Income Taxable, International Equity, …).",
  management_style: "Active or Passive.",
  fund_type_code: "J.P. Morgan fund-type code (N_ETF for these ETFs).",
  currency: "The fund's currency (e.g. USD).",
  morningstar_rating: "Morningstar overall star rating (1–5; 0 when unrated).",
  inception_date: "Fund inception date.",
  net_assets: "Assets under management, in the fund's currency.",
  nav: "Latest net asset value per share.",
  nav_date: "Date of the reported NAV.",
  market_price: "Latest market price per share.",
  premium_discount_percent: "Market price premium or discount to NAV, percent points.",
  sec_yield_percent: "30-day SEC yield, percent points.",
  ytd_return_percent: "Year-to-date NAV return, percent points.",
  return_1y_percent: "Annualized 1-year NAV return, percent points.",
  return_3y_percent: "Annualized 3-year NAV return, percent points.",
  return_5y_percent: "Annualized 5-year NAV return, percent points.",
  return_10y_percent: "Annualized 10-year NAV return, percent points.",
  return_since_inception_percent: "Annualized since-inception NAV return, percent points.",
  kiid_url: "URL of the fund's key information document.",
};

/** Table-level metadata for the products base table (the vgi.* doc/discovery channels). */
const PRODUCTS_TABLE_TAGS: Record<string, string> = {
  "vgi.category": "catalog",
  domain: "finance",
  "vgi.keywords": JSON.stringify([
    "ETF",
    "fund catalog",
    "product list",
    "NAV",
    "ticker",
    "CUSIP",
    "asset class",
  ]),
  "vgi.doc_llm":
    "The J.P. Morgan US ETF catalog as a plain table (query it directly, no arguments): one row " +
    "per US ETF with ticker, CUSIP, name, asset class, management style, NAV and market price, " +
    "premium/discount, 30-day SEC yield, annualized returns, Morningstar rating, net assets, and " +
    "inception date. Narrow it with a WHERE clause on ticker, asset_class, management_style, and " +
    "so on. Percent columns hold percent points (7.77 means 7.77%). Note: the expense ratio is " +
    "NOT in this bulk feed — get it from fund_details. Start here to find a fund's ticker.",
  "vgi.doc_md":
    "## products\n\n" +
    "The J.P. Morgan US ETF catalog as a base table — one row per fund. It takes no arguments; " +
    "query it directly and filter with a WHERE clause (e.g. `WHERE asset_class = 'U.S. Equity' " +
    "ORDER BY net_assets DESC`; see the example queries). Percent columns (`*_percent`) are in " +
    "**percent points** (a return of 7.77 means 7.77%). The `ticker` column is the key for the " +
    "other functions. The expense ratio is not in this bulk feed — use `fund_details` for it.",
  "vgi.example_queries": JSON.stringify([
    { description: "Largest J.P. Morgan ETFs by assets", sql: "SELECT ticker, name, net_assets FROM jpmorgan.main.products ORDER BY net_assets DESC LIMIT 10" },
    { description: "Fixed-income ETFs", sql: "SELECT ticker, name, sec_yield_percent FROM jpmorgan.main.products WHERE asset_class LIKE 'Fixed Income%' ORDER BY name" },
    { description: "Look up a single fund by ticker", sql: "SELECT ticker, name, nav, sec_yield_percent FROM jpmorgan.main.products WHERE ticker = 'JEPI'" },
  ]),
  "vgi.result_columns_schema": resultColumnsSchema(productsSchema(), PRODUCTS_COLUMN_COMMENTS),
};

/** Per-column comments for the holdings table. */
const HOLDINGS_COLUMN_COMMENTS: Record<string, string> = {
  fund_ticker: "The fund's ticker (e.g. JEPI) — the hive partition key; constant for every row of a fund. Filter on it to pick funds; omit to stream all.",
  as_of_date: "The effective date J.P. Morgan reports for these holdings (current holdings only).",
  name: "Constituent / security description.",
  ticker: "Constituent ticker (the holding's own ticker; distinct from fund_ticker).",
  cusip: "Constituent CUSIP / security id.",
  weight_percent: "Percent of the fund's market value, 0–100 (1.71 = 1.71%; weights sum to ~100).",
  market_value: "Market value held, in the fund's currency.",
  shares: "Quantity held, as a count of shares/units (or par for bonds).",
  sec_type: "Security type classification (e.g. DOMESTIC COMMON STOCK, TREASURY NOTES).",
  sector: "GICS-style sector (equity positions).",
  industry: "Industry classification (equity positions).",
  country: "Country of the position.",
  currency: "Currency of the position.",
  coupon_percent: "Coupon rate, percent points (fixed income only).",
  maturity_date: "Final legal maturity date (fixed income only).",
  rating: "S&P / Moody's / Fitch rating string (fixed income only).",
  yield_percent: "Security yield, percent points (when reported).",
};

/** Table-level metadata for the holdings base table (fund-partitioned, current-only). */
const HOLDINGS_TABLE_TAGS: Record<string, string> = {
  "vgi.category": "holdings",
  domain: "finance",
  "vgi.keywords": JSON.stringify([
    "holdings",
    "constituents",
    "portfolio",
    "weights",
    "positions",
    "exposure",
  ]),
  "vgi.doc_llm":
    "Detailed current portfolio holdings for J.P. Morgan ETFs as a hive-partitioned table — the " +
    "FULL published position list per fund. It is partitioned by fund_ticker (the FUND's ticker, " +
    "distinct from the constituent `ticker` column): filter `WHERE fund_ticker = '…'` (or " +
    "`fund_ticker IN (…)`) to pick funds, or scan with no filter to stream EVERY fund's holdings " +
    "(75 funds — slow, so prefer a filter). Holdings are current-only — J.P. Morgan reports a " +
    "single effective date (the as_of_date column), with no historical time travel. Rows come " +
    "back weight-descending; weight_percent is in percent points (1.71 = 1.71%); bond funds also " +
    "fill coupon/maturity/rating. Join on fund_ticker to products.ticker for fund-level facts.",
  "vgi.doc_md":
    "## holdings\n\n" +
    "Detailed **current** fund holdings as a **hive-partitioned table** (the full published " +
    "position list per fund), partitioned by `fund_ticker` (the fund's ticker). `fund_ticker` is " +
    "distinct from `ticker` (the constituent's own ticker). Filter `WHERE fund_ticker = 'JEPI'` " +
    "for one fund, or scan with no filter to stream every fund (see the example queries).\n\n" +
    "`WHERE fund_ticker IN ('JEPI','JPST')` fans out per partition; an unfiltered scan streams " +
    "every fund (75 partitions — slow). Holdings are **current-only** (J.P. Morgan reports one " +
    "effective date; no time travel). `weight_percent` is in percent points (1.71 = 1.71%).",
  "vgi.result_columns_schema": resultColumnsSchema(holdingsSchema(), HOLDINGS_COLUMN_COMMENTS),
  "vgi.example_queries": JSON.stringify([
    { description: "Top 10 current holdings of JEPI", sql: "SELECT ticker, name, weight_percent FROM jpmorgan.main.holdings WHERE fund_ticker = 'JEPI' ORDER BY weight_percent DESC LIMIT 10" },
    { description: "Two funds at once (partition fan-out)", sql: "SELECT fund_ticker, ticker, weight_percent FROM jpmorgan.main.holdings WHERE fund_ticker IN ('JEPI', 'JPST')" },
    { description: "A bond fund also fills coupon / maturity", sql: "SELECT name, coupon_percent, maturity_date, weight_percent FROM jpmorgan.main.holdings WHERE fund_ticker = 'JPST' LIMIT 5" },
  ]),
};

/** Catalog-level tags: docs, discovery, provenance, and the agent-test suite. */
const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "J.P. Morgan ETFs",
  "vgi.doc_llm":
    "J.P. Morgan Asset Management US ETF data as SQL tables and a table function. Reach for it to " +
    "screen the ETF lineup on key facts (NAV, assets, yield, returns, asset class), to inspect " +
    "what a fund currently holds, and to pull a fund's full characteristics. The central concept " +
    "is the fund, identified by its exchange ticker (e.g. JEPI); start from the catalog to find " +
    "that key, then drill into a specific fund. Holdings are current-only (no historical as-of), " +
    "and there is no distribution or NAV time series. Data is J.P. Morgan's public product feed: " +
    "best-effort, for informational use.",
  "vgi.doc_md":
    "## J.P. Morgan ETFs\n\n" +
    "J.P. Morgan Asset Management US ETF data, exposed as DuckDB tables and a table function.\n\n" +
    "The **fund** is the unit of the data and is keyed by an exchange `ticker` (e.g. `JEPI`) — " +
    "begin at the catalog to discover that key, then drill into a fund. Fund holdings are " +
    "**current-only**: J.P. Morgan reports a single effective date per fund, so there is no " +
    "historical time travel, and no distribution or NAV time series is published.\n\n" +
    "Data is provided for informational use; review J.P. Morgan's terms before redistribution.",
  "vgi.keywords": JSON.stringify([
    "ETF",
    "J.P. Morgan",
    "JPMorgan",
    "holdings",
    "portfolio",
    "fund",
    "NAV",
    "expense ratio",
    "active ETF",
    "JEPI",
  ]),
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC",
  "vgi.license": "MIT",
  "vgi.support_contact": ISSUES,
  "vgi.support_policy_url": ISSUES,
  // At least one guaranteed-runnable example at the catalog level (VGI509). No expected_result —
  // J.P. Morgan data is live/non-deterministic.
  "vgi.executable_examples": JSON.stringify([
    {
      name: "largest_etfs",
      description: "The largest J.P. Morgan ETFs by assets",
      sql: "SELECT ticker, name, net_assets FROM jpmorgan.main.products ORDER BY net_assets DESC LIMIT 5",
    },
    {
      name: "top_holdings",
      description: "The top holdings of the JPMorgan Equity Premium Income ETF",
      sql: "SELECT ticker, name, weight_percent FROM jpmorgan.main.holdings WHERE fund_ticker = 'JEPI' ORDER BY weight_percent DESC LIMIT 5",
    },
  ]),
  // Agent-suitability suite (catalog only). Each task carries a deterministic check_sql that
  // asserts specific ground truth; reference_sql is omitted (live data + free-form analyst queries
  // won't reproduce an exact result set). success_criteria records what a correct answer looks like.
  "vgi.agent_test_tasks": JSON.stringify([
    {
      name: "jepi_exists",
      prompt: "Does J.P. Morgan offer an ETF with the ticker JEPI, and what is it called?",
      check_sql: "SELECT count(*) > 0 FROM jpmorgan.main.products WHERE ticker = 'JEPI'",
      success_criteria: "The answer confirms JEPI is the JPMorgan Equity Premium Income ETF, found via the products table.",
    },
    {
      name: "jepi_top_holding",
      prompt: "What is the single largest holding of the JPMorgan Equity Premium Income ETF (JEPI) right now?",
      check_sql: "SELECT count(*) > 0 FROM jpmorgan.main.holdings WHERE fund_ticker = 'JEPI'",
      success_criteria: "The answer names JEPI's top holding by weight, obtained from the holdings table.",
    },
    {
      name: "jepi_holdings_scan",
      prompt: "Using the holdings() backing scan function, list a few JEPI constituents by weight.",
      check_sql: "SELECT count(*) > 0 FROM jpmorgan.main.holdings() WHERE fund_ticker = 'JEPI'",
      success_criteria: "The answer returns JEPI constituents via the holdings() backing scan function filtered by ticker.",
    },
    {
      name: "jepi_expense_ratio",
      prompt: "What is the expense ratio of the JPMorgan Equity Premium Income ETF (JEPI)?",
      check_sql: "SELECT count(*) > 0 FROM jpmorgan.main.fund_details('JEPI') WHERE expense_ratio_percent IS NOT NULL",
      success_criteria: "The answer reports JEPI's net expense ratio (a small percentage) from the fund_details function.",
    },
    {
      name: "jepi_benchmark",
      prompt: "Which benchmark does the JPMorgan Equity Premium Income ETF (JEPI) track?",
      check_sql: "SELECT count(*) > 0 FROM jpmorgan.main.fund_details('JEPI') WHERE primary_benchmark IS NOT NULL",
      success_criteria: "The answer names JEPI's primary benchmark (the S&P 500 Index) from the fund_details function.",
    },
    {
      name: "largest_fund",
      prompt: "Which J.P. Morgan ETF has the most assets under management?",
      check_sql: "SELECT count(*) > 0 FROM jpmorgan.main.products WHERE net_assets IS NOT NULL",
      success_criteria: "The answer names the largest J.P. Morgan ETF by net_assets, obtained by ordering the products table.",
    },
  ]),
};

/** Schema-level tags: docs, discovery, the category registry, and shown examples. */
const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "J.P. Morgan Fund Data",
  "vgi.doc_llm":
    "Functions that return J.P. Morgan ETF data at two levels. At the catalog level you screen " +
    "the whole lineup on key facts and resolve a fund's key. At the fund level you drill into one " +
    "fund — its full current holdings and its wide characteristics snapshot. A fund is keyed by " +
    "its exchange `ticker` (e.g. `JEPI`); resolve the key at the catalog level first. Holdings " +
    "are current-only (no historical as-of).",
  "vgi.doc_md":
    "## J.P. Morgan fund data\n\n" +
    "Work happens at two levels. **Catalog level:** screen the lineup on key facts and find a " +
    "fund's key. **Fund level:** drill into a single fund — its full current constituents and its " +
    "characteristics. A fund is keyed by its exchange `ticker` (e.g. `JEPI`).\n\n" +
    "Holdings are current-only: J.P. Morgan reports one effective date per fund, with no " +
    "historical time travel.",
  "vgi.keywords": JSON.stringify(["ETF holdings", "fund catalog", "expense ratio", "portfolio", "NAV"]),
  domain: "finance",
  // Ordered navigation registry; each `name` is referenced by a function's vgi.category.
  "vgi.categories": JSON.stringify([
    { name: "catalog", title: "Fund Catalog", description: "The ETF list and per-fund characteristics." },
    { name: "holdings", title: "Holdings", description: "Detailed current portfolio holdings." },
  ]),
  "vgi.example_queries": JSON.stringify([
    { description: "Largest J.P. Morgan ETFs by assets", sql: "SELECT ticker, name, net_assets FROM jpmorgan.main.products ORDER BY net_assets DESC LIMIT 10" },
    { description: "Top holdings of JEPI", sql: "SELECT ticker, name, weight_percent FROM jpmorgan.main.holdings WHERE fund_ticker = 'JEPI' ORDER BY weight_percent DESC LIMIT 10" },
    { description: "Full characteristics for JEPI", sql: "SELECT ticker, primary_benchmark, expense_ratio_percent, sec_yield_percent FROM jpmorgan.main.fund_details('JEPI')" },
  ]),
};

/**
 * @param functions    the callable table functions (fund_details) — NOT products or holdings,
 *                      which are base tables.
 * @param productsScan  the zero-arg scan backing the `products` base table.
 * @param holdingsScan  the pushdown scan backing the `holdings` base table.
 * Both scans are registered for scan dispatch but exposed to DuckDB only as tables.
 */
export function makeCatalog(
  functions: VgiFunction[],
  productsScan: VgiFunction,
  holdingsScan: VgiFunction,
): CatalogDescriptor {
  return {
    name: "jpmorgan",
    defaultSchema: "main",
    comment:
      "J.P. Morgan US ETF data as DuckDB tables: products (catalog) & holdings (fund-partitioned, " +
      "current-only) tables, plus fund_details — vgi-etf-jpmorgan",
    sourceUrl: REPO,
    tags: CATALOG_TAGS,
    schemas: [
      {
        name: "main",
        comment: "J.P. Morgan fund data: ETF catalog, detailed current holdings, and per-fund characteristics.",
        tags: SCHEMA_TAGS,
        functions: [...functions, holdingsScan],
        tables: [
          {
            name: "products",
            function: productsScan,
            arguments: new Arguments([], new Map()),
            // Each fund has a unique CUSIP (advisory — not enforced on scan).
            primaryKey: [["cusip"]],
            // The J.P. Morgan US ETF lineup is 75 funds; headroom to ~150.
            inlinedCardinality: { estimate: 75n, max: 150n },
            comment:
              "Every J.P. Morgan US ETF with its key facts, one row per fund. Query directly (no " +
              "arguments) and filter with WHERE; percent columns are in percent points.",
            columnComments: PRODUCTS_COLUMN_COMMENTS,
            tags: PRODUCTS_TABLE_TAGS,
          },
          {
            name: "holdings",
            function: holdingsScan,
            arguments: new Arguments([], new Map()),
            // fund_ticker is always populated (the scan tags every row with its fund).
            notNull: ["fund_ticker"],
            // Row identity within the current snapshot: a fund (fund_ticker) holds each security
            // (cusip) once — J.P. Morgan publishes aggregated positions. Advisory only (like
            // products' key): not enforced on a read-only scan, and cusip is null for the occasional
            // non-CUSIP line (cash / FX), so treat it as the intended identity, not a guarantee.
            primaryKey: [["fund_ticker", "cusip"]],
            // Hive partition key: fund_ticker. A WHERE fund_ticker = … / IN (…) filter is pushed
            // down to fetch just those funds; an unfiltered scan streams every fund (all
            // partitions). J.P. Morgan holdings are current-only — NO time travel.
            // Whole-table estimate: 75 funds; a fund ranges from ~100 to ~800 positions.
            inlinedCardinality: { estimate: 60000n, max: 200000n },
            comment:
              "Detailed current fund holdings (full position list), hive-partitioned by " +
              "fund_ticker (filter WHERE fund_ticker = … for one fund, or scan unfiltered for " +
              "all). Current-only — no time travel; as_of_date reflects J.P. Morgan's reported " +
              "effective date.",
            columnComments: HOLDINGS_COLUMN_COMMENTS,
            tags: HOLDINGS_TABLE_TAGS,
          },
        ],
      },
    ],
  };
}
