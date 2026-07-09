// Archetype proof for the fund_details driver: catalog identity + product-data profile merged into
// one wide row. SDK-free.

import { test, expect } from "bun:test";
import { parseFundDetails, fetchFundDetails, parseProducts } from "../src/jpmorgan.js";
import { FakeJpmorgan, catalogEnvelope, jepiProductData } from "./fake-jpmorgan.js";

const jepiProduct = () => parseProducts(catalogEnvelope(), "JEPI")[0]!;

test("parseFundDetails merges the catalog row + the product-data profile into one row", () => {
  const row = parseFundDetails(jepiProduct(), jepiProductData());
  // identity + market facts from the catalog row
  expect(row.ticker).toBe("JEPI");
  expect(row.cusip).toBe("46641Q332");
  expect(row.name).toBe("JPMorgan Equity Premium Income ETF");
  expect(row.management_style).toBe("Active");
  expect(row.nav).toBe(56.52260366);
  expect(row.morningstar_rating).toBe(3);
  expect(row.sec_yield_percent).toBe(8.2);
  expect(row.return_1y_percent).toBe(7.77);
  // profile from product-data
  expect(row.expense_ratio_percent).toBe(0.35); // percent points already (NOT a fraction)
  expect(row.gross_expense_ratio_percent).toBe(0.35);
  expect(row.net_assets).toBe(44982101058.15);
  expect(row.num_holdings).toBe(131);
  expect(row.as_of_date).toBe(Math.floor(Date.UTC(2026, 6, 8) / 1000));
  expect(row.primary_benchmark).toBe("S&P 500 Index");
  expect(row.dividends_frequency).toBe("MDEC");
  expect(row.strategy).toContain("Generates income");
  expect(row.strategy).toContain("; "); // the ~~ separator became "; "
  expect(row.objective).toContain("current income");
});

test("parseFundDetails degrades to nulls on empty inputs", () => {
  const row = parseFundDetails(null, { fundData: null });
  expect(row.ticker).toBeNull();
  expect(row.expense_ratio_percent).toBeNull();
  expect(row.primary_benchmark).toBeNull();
  expect(row.num_holdings).toBeNull();
});

test("fetchFundDetails requests product-data for the CUSIP and merges", async () => {
  const fake = FakeJpmorgan.router({ productData: { "46641Q332": jepiProductData() } });
  const row = await fetchFundDetails(fake.get, jepiProduct());
  expect(row.expense_ratio_percent).toBe(0.35);
  expect(row.num_holdings).toBe(131);
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]).toContain("cusip=46641Q332");
});
