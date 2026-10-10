# Financial cockpit redesign — feature preservation map

Presentation changes only. The model, tax engine, Monarch import and saved-case contracts remain authoritative.

| Existing capability | New home |
|---|---|
| Observed balances, classifications, account history | Overview → Accounts & holdings |
| Imported spending, pace, rolling 3/6/12 months, refunds | Spending & Budget → Spending |
| Shared budget, year edits, percentage rules, emergency funding | Spending & Budget → Budget; row details for rules |
| NYC calibration, baseline assumptions, suggestions | Budget → Calibration & setup |
| Plan items, one-offs, rule ledger, full budget grid | Budget → Scheduled costs & details |
| Wealth, income/tax, cash flow, full annual table | Future → Life timeline / Wealth / Income & tax / Cash flow / Calculations |
| Stripe position, compensation, valuation path, assumptions | Overview → Stripe equity |
| What-if presets, scenario save, stress tests, sensitivity, Monte Carlo | Decisions → What-if; supporting analysis folds |
| Housing affordability, timing, carrying cost, closing funds, income pause, tender cap | Decisions → Housing → Affordability |
| Mortgage payment, property tax, maintenance, amortization, refinancing | Decisions → Housing → Monthly costs |
| Rent/buy returns, horizon, assumptions, breakeven, attribution | Decisions → Housing → Rent vs. buy |
| Scenario deltas and full comparison matrix | Decisions → Compare; full matrix in details |
| Watchlist checks, opportunities, tax context | Overview → Watchlist |
| Advisor conversations, streaming, proposed edits | Advisor |
| Export, print, snapshot, demo and story | Rail → Present & export |
| All original inputs | Rail → Plan assumptions |

Numbers render at their actual values; motion is restricted to transitions and chart updates. Reduced-motion preferences are respected. Data freshness and completeness must remain distinguishable. Cash surplus must never include unsold equity.

## Visual clarity pass

Budget now opens with actual pace versus plan on a shared scale, category drivers, a planned cost composition ring, and ranked category comparisons. Spending uses the existing category aggregation for its composition and insights; scope controls only show rolling windows supported by the available history. Negative adjustments and refunds are identified separately from positive composition segments.

Norm’s annual compensation editor and growth assumptions now live together in Plan assumptions. Stripe keeps a shortcut and focuses on equity holdings, valuation and sale policy. The annual edit refreshes totals in place without rebuilding the active table.

## Final design pass

Reduced competition between focal readouts and secondary cards. Budget comparisons now use amber for overruns, dashed bars for planned-only values, direct variance labels, a consistent dollar scale and exact accessible labels. Leading overages link directly to their budget lines. The spending composition names its active period.

The future timeline adds a monthly cash-flow comparison for the selected year, with after-tax cash pay, spending and the resulting asset-funding need or cash remainder. Responsive spacing, keyboard focus and reduced-motion handling are consistent across these additions. Compensation remains in Plan assumptions.

Validation: application regression suite, DOM interaction smoke checks, CSS parse and standalone-preview inline-script parse. Live-browser visual verification remains pending.

## Focused Spending and Budget redesign

Spending now has one primary view at a time: category breakdown, run-rate trend, or current-month pace. Supporting tables, average cards, classification and import tools share one detail drawer. Budget consolidates its readout and category comparison, removes the duplicate composition ring, and opens the relevant editor when a category is selected. All categories remain reachable.

Current-year category comparisons identify over/under plan with red/green colors and text; absent mappings remain unknown rather than zero. Future-year amounts use review prompts rather than actual-spending judgments. Household guide comparisons normalize expense inflation to base-year purchasing power. Optional camp and bar/bat mitzvah additions remain editable and require explicit acceptance; ongoing unaccepted camp prompts stay visible during the relevant years. One-off costs and signed adjustments remain in the primary planned-cost breakdown.

Overview uses a financial briefing with observed position, the annual cash-pay surplus/shortfall path and a next-question action; detailed projections and watchlist evidence remain available. Housing tools and compensation assumptions are preserved.

Validation: 1,272 regression and targeted presentation tests, CSS parse, diff checks and embedded preview-script parse. A live-browser visual check of this revision remains pending; publishing has not been authorized.

## Forest and ivory finishing pass

Warm ivory page backgrounds, forest navigation and sage highlight panels now use one palette. Neutral chart labels and Stripe valuation graphics follow the same palette; red/green budget status and amber planning prompts retain their meaning. Main text, secondary text, panel captions, navigation and budget status text pairs were checked for readable contrast (at least 4.5:1). A inherited rule that hid the last Overview balance tile was corrected so Vested Stripe remains visible. Financial model calculations and saved inputs are unchanged.
