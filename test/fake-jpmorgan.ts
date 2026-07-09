// A tiny in-process fake of the J.P. Morgan FundsMarketingHandler BFF — enough to prove the driver:
// it records every requested URL (so a test can assert the wire contract) and returns canned
// envelopes shaped like the real /fund-explorer catalog array and the per-fund /product-data object.
// No network. Matches the driver's injected `get(url) => Promise<unknown>` signature. The fixtures
// mirror the real response shapes observed live (an equity ETF JEPI and a fixed-income ETF JPST).

export class FakeJpmorgan {
  /** Every URL this fake was asked for, in order. */
  readonly calls: string[] = [];

  constructor(private readonly responder: (url: string) => unknown) {}

  get = async (url: string): Promise<unknown> => {
    this.calls.push(url);
    return this.responder(url);
  };

  /** Route by URL: the catalog vs each fund's product-data (keyed by its CUSIP in the query). */
  static router(routes: { catalog?: unknown; productData?: Record<string, unknown> }): FakeJpmorgan {
    return new FakeJpmorgan((url) => {
      if (url.includes("/fund-explorer")) return routes.catalog ?? catalogEnvelope();
      if (url.includes("/product-data")) {
        const cusip = new URL(url).searchParams.get("cusip") ?? "";
        return routes.productData?.[cusip] ?? { fundData: null, error: null };
      }
      return {};
    });
  }
}

// ── /fund-explorer catalog (a JSON ARRAY of fund objects) ──────────────────────

/** A catalog fund object (as nested in the fund-explorer array). */
function catalogFund(opts: {
  ticker: string;
  identifier: string;
  name: string;
  displayName: string;
  assetClass: string;
  managementStyle: string;
  nav: number;
  aum: number;
  secYield: number;
  ytdReturn: number;
  yr1: number;
  morningStar: number;
}): Record<string, unknown> {
  return {
    name: opts.name,
    displayName: opts.displayName,
    displayId: opts.ticker,
    fundTypeCode: "N_ETF",
    shareclassName: `${opts.name}-ETF Shares`,
    identifier: opts.identifier,
    assetClass: opts.assetClass,
    assetClassCode: opts.assetClass,
    ticker: opts.ticker,
    assetsUnderManagement: opts.aum,
    secYield: opts.secYield,
    secYieldEffectiveDate: "2026-06-30",
    fundInceptionDate: "2020-05-20",
    shareClassInceptionDate: "2020-05-20",
    atNavPerformanceReturn: {
      ytd: 0.022,
      yr1: opts.yr1,
      yr3: 0.0899,
      yr5: 0.0747,
      yr10: null,
      inception: 0.1103,
    },
    marketPriceReturns: { ytd: 0.0209, yr1: 0.0766 },
    nav: opts.nav,
    navDate: "2026-07-08",
    currencyCode: "USD",
    marketPrice: opts.nav - 0.01,
    morningStarRating: opts.morningStar,
    ytdReturn: opts.ytdReturn,
    distributionFrequency: null,
    premiumDiscountPercentage: -0.0046,
    managementStyle: opts.managementStyle,
    country: "us",
    kiidUrl: `https://wl.fundsquare.net/serv/down-doc/request?cdClient=jpmorgan&isin=${opts.identifier}&docTypeCode=KIDD&docLang=EN&docCountry=US`,
  };
}

/** A catalog array with one equity ETF (JEPI) and one fixed-income ETF (JPST). */
export function catalogEnvelope(): unknown {
  return [
    catalogFund({
      ticker: "JEPI",
      identifier: "46641Q332",
      name: "JPMorgan Equity Premium Income ETF",
      displayName: "Equity Premium Income ETF",
      assetClass: "U.S. Equity",
      managementStyle: "A",
      nav: 56.52260366,
      aum: 44982101058.15,
      secYield: 0.082,
      ytdReturn: 0.0294,
      yr1: 0.0777,
      morningStar: 3,
    }),
    catalogFund({
      ticker: "JPST",
      identifier: "46641Q837",
      name: "JPMorgan Ultra-Short Income ETF",
      displayName: "Ultra-Short Income ETF",
      assetClass: "Fixed Income Taxable",
      managementStyle: "A",
      nav: 50.61,
      aum: 30000000000,
      secYield: 0.0455,
      ytdReturn: 0.021,
      yr1: 0.052,
      morningStar: 4,
    }),
  ];
}

// ── /product-data per-fund object (holdings + characteristics) ──────────────────

/** A product-data envelope for the JEPI equity ETF (two equity holdings + expenses). */
export function jepiProductData(): unknown {
  return {
    fundData: {
      name: "JPMorgan Equity Premium Income ETF",
      currencyCode: "USD",
      numberOfHoldings: 131,
      numberOfHoldingsEffectiveDate: "2026-07-08",
      fundInceptionDate: "2020-05-20",
      dividendsFrequency: "MDEC",
      objective:
        "The investment objective of the Fund is to seek current income while maintaining " +
        "prospects for capital appreciation.",
      strategy:
        "Generates income through a combination of selling options and investing in U.S. large " +
        "cap stocks~~Constructs a diversified, low volatility equity portfolio",
      aum: { date: "2026-07-08", netAsset: 44982101058.15, value: null, currencyCode: null },
      premiumDiscountPercentage: -0.0046,
      shareClass: {
        expenses: { netExpense: 0.35, grossExpense: 0.35, managementFee: null },
        fees: { expenseRatio: 0.35, annualOperatingExpenses: 0.35 },
      },
      benchmarks: [
        { benchmark: { identifier: "abc", code: "N/A", name: "S&P 500 Index", longName: null } },
      ],
      // Top-10 subset (what the site shows by default) — the driver ignores this in favor of All.
      dailyHoldings: { effectiveDate: "2026-07-08", data: [{ securityTicker: "JNJ" }] },
      // Full holdings (what the driver reads).
      dailyHoldingsAll: {
        effectiveDate: "2026-07-08",
        data: [
          {
            marketValue: 765315285,
            netAssetValuePercent: 1.7,
            securityDescription: "JOHNSON & JOHNSON COMMON",
            securityId: "478160104",
            securityTicker: "JNJ",
            securityType: "DOMESTIC COMMON STOCK",
            securityCusip: null,
            shares: 2905525,
            marketValuePercent: 1.71,
            couponRate: null,
            finalLegalMaturityDate: null,
            snpRating: null,
            country: "United States",
            currencyCode: "USD",
            sector: "Health Care",
            industry: "Pharmaceuticals",
            navDate: "2026-07-08",
          },
          {
            marketValue: 500000000,
            netAssetValuePercent: 1.1,
            securityDescription: "APPLE INC COMMON",
            securityId: "037833100",
            securityTicker: "AAPL",
            securityType: "DOMESTIC COMMON STOCK",
            securityCusip: null,
            shares: 2000000,
            marketValuePercent: 1.12,
            couponRate: null,
            finalLegalMaturityDate: null,
            snpRating: null,
            country: "United States",
            currencyCode: "USD",
            sector: "Information Technology",
            industry: "Technology Hardware",
            navDate: "2026-07-08",
          },
        ],
      },
    },
    error: null,
  };
}

/** A product-data envelope for the JPST bond ETF (a treasury holding with coupon/maturity). */
export function jpstProductData(): unknown {
  return {
    fundData: {
      name: "JPMorgan Ultra-Short Income ETF",
      currencyCode: "USD",
      numberOfHoldings: 794,
      numberOfHoldingsEffectiveDate: "2026-07-08",
      dividendsFrequency: "MDEC",
      objective: "The Fund seeks to provide current income.",
      strategy: "Invests in a diversified portfolio of short-term investment-grade fixed income",
      aum: { date: "2026-07-08", netAsset: 30000000000, value: null, currencyCode: null },
      shareClass: {
        expenses: { netExpense: 0.18, grossExpense: 0.18 },
        fees: { expenseRatio: 0.18, annualOperatingExpenses: 0.18 },
      },
      benchmarks: [
        { benchmark: { name: "ICE BofA 3-Month US Treasury Bill Index" } },
      ],
      dailyHoldingsAll: {
        effectiveDate: "2026-07-08",
        data: [
          {
            marketValue: 885424250,
            netAssetValuePercent: 2.23,
            securityDescription: "UNITED STATES TREAS 3.375% 02/28",
            securityId: "91282CQB0",
            securityTicker: "T",
            securityType: "TREASURY NOTES",
            securityCusip: null,
            shares: 897200000,
            marketValuePercent: 2.24,
            couponRate: 3.375,
            finalLegalMaturityDate: "2028-02-29",
            snpRating: "AA+",
            moodysRating: "Aaa",
            country: "United States",
            currencyCode: "USD",
            sector: null,
            industry: null,
            securityYield: 3.9,
            navDate: "2026-07-08",
          },
        ],
      },
    },
    error: null,
  };
}
