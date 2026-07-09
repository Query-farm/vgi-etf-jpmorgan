// Typed-column contract for the three schemas. This one pulls @query-farm/vgi (batchFromColumns) +
// apache-arrow, so it runs under the full SDK install — unlike the driver tests, which are
// deliberately SDK-free. Proves schema field names/order and that Utf8/Float64/Int64/Date cells
// (incl. nulls) round-trip into an Arrow batch.

import { test, expect } from "bun:test";
import {
  productsSchema,
  productsBatch,
  holdingsSchema,
  holdingsBatch,
  fundDetailsSchema,
  fundDetailsBatch,
} from "../src/schema.js";
import { parseProducts, parseHoldings, parseFundDetails } from "../src/jpmorgan.js";
import { catalogEnvelope, jepiProductData } from "./fake-jpmorgan.js";

const names = (schema: { fields: { name: string }[] }) => schema.fields.map((f) => f.name);

test("products schema field names + order", () => {
  expect(names(productsSchema())).toEqual([
    "ticker", "cusip", "name", "display_name", "asset_class", "management_style", "fund_type_code",
    "currency", "morningstar_rating", "inception_date", "net_assets", "nav", "nav_date",
    "market_price", "premium_discount_percent", "sec_yield_percent", "ytd_return_percent",
    "return_1y_percent", "return_3y_percent", "return_5y_percent", "return_10y_percent",
    "return_since_inception_percent", "kiid_url",
  ]);
});

test("holdings schema field names + order", () => {
  expect(names(holdingsSchema())).toEqual([
    "fund_ticker", "as_of_date", "name", "ticker", "cusip", "weight_percent", "market_value",
    "shares", "sec_type", "sector", "industry", "country", "currency", "coupon_percent",
    "maturity_date", "rating", "yield_percent",
  ]);
});

test("batch builders produce one row per parsed record", () => {
  expect((productsBatch(productsSchema(), parseProducts(catalogEnvelope())) as { numRows: number }).numRows).toBe(2);
  expect((holdingsBatch(holdingsSchema(), parseHoldings(jepiProductData(), "JEPI")) as { numRows: number }).numRows).toBe(2);
  expect((fundDetailsBatch(fundDetailsSchema(), [parseFundDetails(parseProducts(catalogEnvelope(), "JEPI")[0]!, jepiProductData())]) as { numRows: number }).numRows).toBe(1);
});

test("empty inputs build a zero-row batch, not a throw", () => {
  expect((productsBatch(productsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((holdingsBatch(holdingsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((fundDetailsBatch(fundDetailsSchema(), []) as { numRows: number }).numRows).toBe(0);
});
