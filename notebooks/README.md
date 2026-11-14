# J.P. Morgan: reported maturity coverage

[Open the executed notebook](01_reported_maturity_window.ipynb). It retrieves
JPST's current catalog entry, details and holdings through real VGI, compares row
shares with positive-weight shares inside a date window, and shows the security
types behind that result. Missing dates remain visible throughout.

## Run from this directory

Install [uv](https://docs.astral.sh/uv/), then:

```bash
uv sync --frozen
uv run python execute.py
```

The notebook environment locks Python 3.13–3.14 dependencies and published
Haybarn 2.0.0rc11. The literal SQL location is
`github-auto://Query-farm/vgi-etf-jpmorgan@v0.4.0`; Haybarn downloads the published
native worker for the platform. No Bun installation, local worker build, worker
checkout, API key, or globally registered kernel is required. Internet access to
GitHub, community extensions and J.P. Morgan is required.

To use an editor, register and select the notebook environment:

```bash
uv run python -m ipykernel install --user --name jpmorgan-examples \
  --display-name "Python (vgi-etf-jpmorgan notebooks)"
```

Restart/run all after changing parameters. SQL and parameters remain visible;
Python presentation code is folded. This folder includes its relative assets and
helpers and can be copied outside the repository.

## Experiment

```bash
uv run python execute.py --parameters '{"HORIZON_DAYS":730}' \
  --output-dir validation/horizon-730
```

The default is 365 calendar days. The inclusive interval starts at each row's
reported holdings date; the accepted horizon is 30–1,095 days. The experiment
widens only this window. For unchanged input, its count and positive weight
cannot fall, while the missing-date category remains unchanged. A fresh run
retrieves current data again: compare dates and coverage, and allow for same-date
issuer revisions. Restore 365 for the default.

The runner executes fresh kernels and replaces saved notebooks only after
success. Parameter overrides require a separate output directory, which receives
execution and branding companions. Validation logs and exported charts are ignored.

## Source and limits

The source is J.P. Morgan's public FundsMarketingHandler `fund-explorer` and
`product-data` responses for [JPST](https://am.jpmorgan.com/us/en/asset-management/adv/products/jpmorgan-ultra-short-income-etf-etf-shares-46641q837).
Each object is materialized once before local SQL captures. The notebook displays
a UTC retrieval clock and the separate source dates. These calls are not an
atomic snapshot, and the worker provides no historical as-of selector. There is
no fixture fallback; unavailable or insufficient source data stops execution.

The worker prefers `dailyHoldingsAll`, falling back to the smaller `dailyHoldings`
block when absent. Diagnostics describe the returned list and display the separate
details holding count without assuming equality. A response with more than ten
rows excludes only a ten-row fallback, not every possible source omission.

The worker's maturity field prefers `finalLegalMaturityDate` and falls back to
`wamMaturityDate`; per-row provenance is not exposed. Mixed instruments and these
mixed date meanings do not establish duration, liquidity or forecast repayments.
Weight columns already use percentage points. The weight denominator sums positive
reported weights, including those with missing dates; signed net weights, zero
and negative rows are displayed separately. Row shares use every returned row.
This is a descriptive SQL example, not an investment recommendation.

To upgrade the worker, change the literal SQL release pin and verify default and
experiment runs with the locked engine. [STANDARD.md](STANDARD.md) describes the
notebook conventions.
