// Archetype proof for jpmorgan.holdings: the product-data holdings driver + fund resolution.
// SDK-free.

import { test, expect } from "bun:test";
import {
  parseHoldings,
  fetchHoldings,
  resolveFund,
  productDataUrl,
} from "../src/jpmorgan.js";
import {
  FakeJpmorgan,
  catalogEnvelope,
  jepiProductData,
  jpstProductData,
} from "./fake-jpmorgan.js";

test("productDataUrl carries the CUSIP + fixed query params", () => {
  const u = productDataUrl("46641Q332");
  expect(u).toContain("/product-data?");
  expect(u).toContain("cusip=46641Q332");
  expect(u).toContain("country=us");
  expect(u).toContain("role=adv");
  expect(u).toContain("userLoggedIn=false");
});

test("parseHoldings reads the FULL holdings list (dailyHoldingsAll), tags fund + as-of", () => {
  const rows = parseHoldings(jepiProductData(), "JEPI");
  expect(rows.length).toBe(2); // dailyHoldingsAll, not the 1-row dailyHoldings top list
  const jnj = rows[0]!;
  expect(jnj.fundTicker).toBe("JEPI");
  expect(jnj.ticker).toBe("JNJ");
  expect(jnj.name).toBe("JOHNSON & JOHNSON COMMON");
  expect(jnj.cusip).toBe("478160104"); // securityCusip null → securityId
  expect(jnj.weightPercent).toBe(1.71); // marketValuePercent, already percent points
  expect(jnj.marketValue).toBe(765315285);
  expect(jnj.shares).toBe(2905525);
  expect(jnj.secType).toBe("DOMESTIC COMMON STOCK");
  expect(jnj.sector).toBe("Health Care");
  expect(jnj.country).toBe("United States");
  expect(jnj.asOfDate).toBe(Math.floor(Date.UTC(2026, 6, 8) / 1000));
  // equity holding leaves the bond-only columns null
  expect(jnj.couponPercent).toBeNull();
  expect(jnj.maturityDate).toBeNull();
  expect(jnj.rating).toBeNull();
});

test("parseHoldings sorts by weight descending (NULLS last)", () => {
  const rows = parseHoldings(jepiProductData(), "JEPI");
  expect(rows.map((r) => r.ticker)).toEqual(["JNJ", "AAPL"]);
  expect(rows[0]!.weightPercent!).toBeGreaterThanOrEqual(rows[1]!.weightPercent!);
});

test("parseHoldings fills coupon / maturity / rating / yield for bond funds", () => {
  const rows = parseHoldings(jpstProductData(), "JPST");
  expect(rows.length).toBe(1);
  const b0 = rows[0]!;
  expect(b0.couponPercent).toBe(3.375);
  expect(b0.maturityDate).toBe(Math.floor(Date.UTC(2028, 1, 29) / 1000));
  expect(b0.rating).toBe("AA+"); // snpRating preferred
  expect(b0.yieldPercent).toBe(3.9);
  expect(b0.secType).toBe("TREASURY NOTES");
  expect(b0.cusip).toBe("91282CQB0");
});

test("parseHoldings returns [] for an empty / null-fundData envelope, no throw", () => {
  expect(parseHoldings({ fundData: null }, "JEPI")).toEqual([]);
  expect(parseHoldings({}, "JEPI")).toEqual([]);
  expect(parseHoldings({ fundData: { dailyHoldingsAll: { data: [] } } }, "JEPI")).toEqual([]);
});

test("resolveFund maps a ticker via the catalog to its product row (CUSIP + identity)", async () => {
  const fake = new FakeJpmorgan(() => catalogEnvelope());
  const row = await resolveFund(fake.get, "jepi");
  expect(row?.ticker).toBe("JEPI");
  expect(row?.cusip).toBe("46641Q332");
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]).toContain("/fund-explorer");
});

test("resolveFund also accepts a raw CUSIP", async () => {
  const fake = new FakeJpmorgan(() => catalogEnvelope());
  const row = await resolveFund(fake.get, "46641Q837");
  expect(row?.ticker).toBe("JPST");
});

test("resolveFund returns null on an unknown fund (caller raises the typed error)", async () => {
  const fake = new FakeJpmorgan(() => catalogEnvelope());
  expect(await resolveFund(fake.get, "ZZZZ")).toBeNull();
});

test("fetchHoldings hits product-data for the fund's CUSIP", async () => {
  const fake = FakeJpmorgan.router({ productData: { "46641Q332": jepiProductData() } });
  const rows = await fetchHoldings(fake.get, "46641Q332", "JEPI");
  expect(rows.length).toBe(2);
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]).toContain("cusip=46641Q332");
});
