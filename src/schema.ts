// Arrow output schemas + row→batch mapping for the products/holdings tables and the fund_details
// function.
//
// J.P. Morgan data has a STABLE, known shape, so we emit real typed columns (not a single JSON
// string): Utf8 identifiers/names, Float64 prices/weights/returns, Int64 counts, and a real Arrow
// DATE (Date32) for every calendar date. `batchFromColumns` defaults to the "rich" representation,
// so a DATE cell is a JS `Date` (at UTC midnight) and an Int64 cell is a bigint. Percent-valued
// columns carry a `_percent` suffix and hold percent-magnitude numbers (e.g. 7.38 = 7.38%);
// ratios that are not percents would NOT be suffixed (JPM exposes none here).

import { Schema, Field, Utf8, Float64, Int64, DateDay } from "@query-farm/apache-arrow";
import { batchFromColumns } from "@query-farm/vgi";
import type { ProductRow, HoldingRow, FundDetailsRow } from "./jpmorgan.js";

const f = (name: string, type: ConstructorParameters<typeof Field>[1]) => new Field(name, type, true);
const date = () => new DateDay();

/**
 * A hive-style partition-column field: carries `vgi.partition_column = "true"` so the DuckDB binder
 * treats it as a partition key. `holdings` is partitioned on `fund_ticker` — each scanned fund is
 * one SINGLE_VALUE partition (see makeHoldingsScan). Mirrors vgi's `partition_field`.
 */
const partitionField = (name: string, type: ConstructorParameters<typeof Field>[1]) =>
  new Field(name, type, true, new Map([["vgi.partition_column", "true"]]));

/** Map an Arrow field type to the DuckDB type name shown in docs. */
function duckdbType(type: unknown): string {
  const n = (type as { constructor?: { name?: string } })?.constructor?.name ?? "";
  if (n.startsWith("Utf8")) return "VARCHAR";
  if (n.startsWith("Float")) return "DOUBLE";
  if (n.startsWith("Int") || n.startsWith("Uint")) return "BIGINT";
  if (n.startsWith("Date")) return "DATE";
  return "VARCHAR";
}

/**
 * Build the `vgi.result_columns_schema` tag value (a JSON array of {name, type, description}) for a
 * static result schema, DRY from the Arrow schema + a name→description map.
 */
export function resultColumnsSchema(schema: Schema, descriptions: Record<string, string>): string {
  return JSON.stringify(
    schema.fields.map((field) => ({
      name: field.name,
      type: duckdbType(field.type),
      description: descriptions[field.name] ?? field.name,
    })),
  );
}

/** bigint | null for an Int64 cell from a JS number that may be null. */
const bigOrNull = (v: number | null): bigint | null => (v == null ? null : BigInt(Math.trunc(v)));

/** JS Date | null for a DATE (Date32) cell from epoch SECONDS at UTC midnight. */
const dateOrNull = (sec: number | null): Date | null => (sec == null ? null : new Date(sec * 1000));

// ── products ──────────────────────────────────────────────────────────────────

export function productsSchema(): Schema {
  return new Schema([
    f("ticker", new Utf8()),
    f("cusip", new Utf8()),
    f("name", new Utf8()),
    f("display_name", new Utf8()),
    f("asset_class", new Utf8()),
    f("management_style", new Utf8()),
    f("fund_type_code", new Utf8()),
    f("currency", new Utf8()),
    f("morningstar_rating", new Int64()),
    f("inception_date", date()),
    f("net_assets", new Float64()),
    f("nav", new Float64()),
    f("nav_date", date()),
    f("market_price", new Float64()),
    f("premium_discount_percent", new Float64()),
    f("sec_yield_percent", new Float64()),
    f("ytd_return_percent", new Float64()),
    f("return_1y_percent", new Float64()),
    f("return_3y_percent", new Float64()),
    f("return_5y_percent", new Float64()),
    f("return_10y_percent", new Float64()),
    f("return_since_inception_percent", new Float64()),
    f("kiid_url", new Utf8()),
  ]);
}

export function productsBatch(schema: Schema, rows: ProductRow[]) {
  return batchFromColumns(
    {
      ticker: rows.map((r) => r.ticker),
      cusip: rows.map((r) => r.cusip),
      name: rows.map((r) => r.name),
      display_name: rows.map((r) => r.display_name),
      asset_class: rows.map((r) => r.asset_class),
      management_style: rows.map((r) => r.management_style),
      fund_type_code: rows.map((r) => r.fund_type_code),
      currency: rows.map((r) => r.currency),
      morningstar_rating: rows.map((r) => bigOrNull(r.morningstar_rating)),
      inception_date: rows.map((r) => dateOrNull(r.inception_date)),
      net_assets: rows.map((r) => r.net_assets),
      nav: rows.map((r) => r.nav),
      nav_date: rows.map((r) => dateOrNull(r.nav_date)),
      market_price: rows.map((r) => r.market_price),
      premium_discount_percent: rows.map((r) => r.premium_discount_percent),
      sec_yield_percent: rows.map((r) => r.sec_yield_percent),
      ytd_return_percent: rows.map((r) => r.ytd_return_percent),
      return_1y_percent: rows.map((r) => r.return_1y_percent),
      return_3y_percent: rows.map((r) => r.return_3y_percent),
      return_5y_percent: rows.map((r) => r.return_5y_percent),
      return_10y_percent: rows.map((r) => r.return_10y_percent),
      return_since_inception_percent: rows.map((r) => r.return_since_inception_percent),
      kiid_url: rows.map((r) => r.kiid_url),
    },
    schema,
  );
}

// ── holdings ────────────────────────────────────────────────────────────────

export function holdingsSchema(): Schema {
  return new Schema([
    // fund_ticker is the hive partition key: the holdings scan emits one SINGLE_VALUE partition per fund.
    partitionField("fund_ticker", new Utf8()),
    f("as_of_date", date()),
    f("name", new Utf8()),
    f("ticker", new Utf8()),
    f("cusip", new Utf8()),
    f("weight_percent", new Float64()),
    f("market_value", new Float64()),
    f("shares", new Float64()),
    f("sec_type", new Utf8()),
    f("sector", new Utf8()),
    f("industry", new Utf8()),
    f("country", new Utf8()),
    f("currency", new Utf8()),
    f("coupon_percent", new Float64()),
    f("maturity_date", date()),
    f("rating", new Utf8()),
    f("yield_percent", new Float64()),
  ]);
}

export function holdingsBatch(schema: Schema, rows: HoldingRow[]) {
  return batchFromColumns(
    {
      fund_ticker: rows.map((r) => r.fundTicker),
      as_of_date: rows.map((r) => dateOrNull(r.asOfDate)),
      name: rows.map((r) => r.name),
      ticker: rows.map((r) => r.ticker),
      cusip: rows.map((r) => r.cusip),
      weight_percent: rows.map((r) => r.weightPercent),
      market_value: rows.map((r) => r.marketValue),
      shares: rows.map((r) => r.shares),
      sec_type: rows.map((r) => r.secType),
      sector: rows.map((r) => r.sector),
      industry: rows.map((r) => r.industry),
      country: rows.map((r) => r.country),
      currency: rows.map((r) => r.currency),
      coupon_percent: rows.map((r) => r.couponPercent),
      maturity_date: rows.map((r) => dateOrNull(r.maturityDate)),
      rating: rows.map((r) => r.rating),
      yield_percent: rows.map((r) => r.yieldPercent),
    },
    schema,
  );
}

// ── fund_details ──────────────────────────────────────────────────────────────

export function fundDetailsSchema(): Schema {
  return new Schema([
    f("ticker", new Utf8()),
    f("cusip", new Utf8()),
    f("name", new Utf8()),
    f("asset_class", new Utf8()),
    f("management_style", new Utf8()),
    f("inception_date", date()),
    f("expense_ratio_percent", new Float64()),
    f("gross_expense_ratio_percent", new Float64()),
    f("net_assets", new Float64()),
    f("num_holdings", new Int64()),
    f("as_of_date", date()),
    f("nav", new Float64()),
    f("premium_discount_percent", new Float64()),
    f("sec_yield_percent", new Float64()),
    f("ytd_return_percent", new Float64()),
    f("return_1y_percent", new Float64()),
    f("return_3y_percent", new Float64()),
    f("return_5y_percent", new Float64()),
    f("return_10y_percent", new Float64()),
    f("return_since_inception_percent", new Float64()),
    f("morningstar_rating", new Int64()),
    f("primary_benchmark", new Utf8()),
    f("dividends_frequency", new Utf8()),
    f("strategy", new Utf8()),
    f("objective", new Utf8()),
  ]);
}

export function fundDetailsBatch(schema: Schema, rows: FundDetailsRow[]) {
  return batchFromColumns(
    {
      ticker: rows.map((r) => r.ticker),
      cusip: rows.map((r) => r.cusip),
      name: rows.map((r) => r.name),
      asset_class: rows.map((r) => r.asset_class),
      management_style: rows.map((r) => r.management_style),
      inception_date: rows.map((r) => dateOrNull(r.inception_date)),
      expense_ratio_percent: rows.map((r) => r.expense_ratio_percent),
      gross_expense_ratio_percent: rows.map((r) => r.gross_expense_ratio_percent),
      net_assets: rows.map((r) => r.net_assets),
      num_holdings: rows.map((r) => bigOrNull(r.num_holdings)),
      as_of_date: rows.map((r) => dateOrNull(r.as_of_date)),
      nav: rows.map((r) => r.nav),
      premium_discount_percent: rows.map((r) => r.premium_discount_percent),
      sec_yield_percent: rows.map((r) => r.sec_yield_percent),
      ytd_return_percent: rows.map((r) => r.ytd_return_percent),
      return_1y_percent: rows.map((r) => r.return_1y_percent),
      return_3y_percent: rows.map((r) => r.return_3y_percent),
      return_5y_percent: rows.map((r) => r.return_5y_percent),
      return_10y_percent: rows.map((r) => r.return_10y_percent),
      return_since_inception_percent: rows.map((r) => r.return_since_inception_percent),
      morningstar_rating: rows.map((r) => bigOrNull(r.morningstar_rating)),
      primary_benchmark: rows.map((r) => r.primary_benchmark),
      dividends_frequency: rows.map((r) => r.dividends_frequency),
      strategy: rows.map((r) => r.strategy),
      objective: rows.map((r) => r.objective),
    },
    schema,
  );
}
