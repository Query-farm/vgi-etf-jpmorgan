// Archetype proof for jpmorgan.products: the /fund-explorer catalog driver + value coercion.
// Imports ONLY our own src + the fake — NO @query-farm/* — so it runs without the SDK installed.

import { test, expect } from "bun:test";
import {
  parseProducts,
  fetchProducts,
  num,
  str,
  pct,
  dateSec,
  decodeEntities,
  cleanText,
  CATALOG_URL,
} from "../src/jpmorgan.js";
import { FakeJpmorgan, catalogEnvelope } from "./fake-jpmorgan.js";

test("num strips $/,/% and parses string numbers, rejects blanks/sentinels", () => {
  expect(num("0.35")).toBe(0.35);
  expect(num("1,182,200")).toBe(1182200);
  expect(num(56.52)).toBe(56.52);
  expect(num("")).toBeNull();
  expect(num("-")).toBeNull();
  expect(num("N/A")).toBeNull();
  expect(num(null)).toBeNull();
});

test("str trims and nulls blanks + sentinels", () => {
  expect(str("  JEPI ")).toBe("JEPI");
  expect(str("")).toBeNull();
  expect(str("-")).toBeNull();
  expect(str("N/A")).toBeNull();
  expect(str(null)).toBeNull();
});

test("pct turns a fraction into percent points (rounded, no float noise)", () => {
  expect(pct(0.082)).toBe(8.2);
  expect(pct(0.0777)).toBe(7.77);
  expect(pct(-0.0046)).toBe(-0.46);
  expect(pct(0.1103)).toBe(11.03);
  expect(pct(null)).toBeNull();
  expect(pct("-")).toBeNull();
});

test("dateSec handles ISO (YYYY-MM-DD), rejects junk", () => {
  expect(dateSec("2020-05-20")).toBe(Math.floor(Date.UTC(2020, 4, 20) / 1000));
  expect(dateSec("2026-07-08")).toBe(Math.floor(Date.UTC(2026, 6, 8) / 1000));
  expect(dateSec("")).toBeNull();
  expect(dateSec("not a date")).toBeNull();
  expect(dateSec("2026-13-45")).toBeNull();
});

test("decodeEntities + cleanText normalize prose", () => {
  expect(decodeEntities("S&amp;P 500 Index")).toBe("S&P 500 Index");
  expect(cleanText("Sell options~~Low volatility portfolio")).toBe(
    "Sell options; Low volatility portfolio",
  );
  expect(cleanText(null)).toBeNull();
});

test("parseProducts maps an equity ETF with typed / date / percent fields", () => {
  const rows = parseProducts(catalogEnvelope());
  expect(rows.length).toBe(2);
  const jepi = rows.find((r) => r.ticker === "JEPI")!;
  expect(jepi.cusip).toBe("46641Q332");
  expect(jepi.name).toBe("JPMorgan Equity Premium Income ETF");
  expect(jepi.display_name).toBe("Equity Premium Income ETF");
  expect(jepi.asset_class).toBe("U.S. Equity");
  expect(jepi.management_style).toBe("Active"); // "A" → Active
  expect(jepi.fund_type_code).toBe("N_ETF");
  expect(jepi.morningstar_rating).toBe(3);
  expect(jepi.nav).toBe(56.52260366);
  expect(jepi.net_assets).toBe(44982101058.15);
  expect(jepi.inception_date).toBe(Math.floor(Date.UTC(2020, 4, 20) / 1000));
  // fractions → percent points
  expect(jepi.sec_yield_percent).toBe(8.2);
  expect(jepi.ytd_return_percent).toBe(2.94);
  expect(jepi.return_1y_percent).toBe(7.77);
  expect(jepi.return_since_inception_percent).toBe(11.03);
  expect(jepi.premium_discount_percent).toBe(-0.46);
});

test("parseProducts classifies a fixed-income ETF", () => {
  const jpst = parseProducts(catalogEnvelope()).find((r) => r.ticker === "JPST")!;
  expect(jpst.asset_class).toBe("Fixed Income Taxable");
  expect(jpst.cusip).toBe("46641Q837");
  expect(jpst.morningstar_rating).toBe(4);
});

test("parseProducts narrows to one ticker (case-insensitive)", () => {
  const one = parseProducts(catalogEnvelope(), "jepi");
  expect(one.length).toBe(1);
  expect(one[0]!.ticker).toBe("JEPI");
  expect(parseProducts(catalogEnvelope(), "ZZZZ")).toEqual([]);
});

test("parseProducts tolerates junk without throwing", () => {
  expect(parseProducts(null)).toEqual([]);
  expect(parseProducts({ x: 1 })).toEqual([]);
  expect(parseProducts([])).toEqual([]);
});

test("fetchProducts hits the catalog URL once", async () => {
  const fake = new FakeJpmorgan(() => catalogEnvelope());
  const rows = await fetchProducts(fake.get);
  expect(rows.length).toBe(2);
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]).toBe(CATALOG_URL);
});
