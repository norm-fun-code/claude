# Stripe awards and compensation

The Stripe workspace has four sections: Position, Awards & elections, Valuation path, and Compensation. Existing plans continue using manual compensation until the user enters reference tender/409A prices and enables the grant model. No current balances or saved scenarios are overwritten by migration.

## Entering awards

Choose the May award year. ARG versus QCA is one election for that award, not a separate election at each vest. Under QCA, the four subsequent payments can each be cash or stock. The estimated award cycle uses the existing quarterly dates, starting after May: June, September, December, then March of the following year. Actual vest dates are editable.

- ARG dollars / May grant price = fixed gross shares; four vests.
- PEG target dollars × performance multiplier / May grant price = fixed gross shares; eight vests. Each grant is calculated separately before overlapping quarters are summed.
- QCA quarter dollars / quarter 409A = shares, unless that quarter is cash.
- Per-year dollar inputs carry forward until overridden. Promotion years can have new amounts; existing actual shares stay fixed.

Defaults of $77,800 ARG and $50,000 PEG × 1 are visible estimates, not a reconstructed grant history. Enter actual shares to anchor known awards.

Actual schedules accept full grants or only remaining unvested vests. Enter gross shares before withholding. A blank share amount remains estimated; 0 explicitly means no shares. Previously entered historical actuals are retained when updating only the remainder. Actual entries override the same award's estimates; they are never added a second time. Historical vests without actuals remain estimated and are flagged, including their effect on full-year compensation/tax estimates.

## Price path

The reference prices anchor February of the reference year. Annual growth for year Y lands at the February Y+1 mark. Before the reference year, prices default to the reference price and are flagged as estimates; historical May overrides should be entered where actual shares are unknown.

Reference valuation is optional. When entered, valuation growth follows the annual return assumptions. An optional ceiling stops further valuation growth at the limit; annual dilution separately affects price per share. The existing annual return inputs and long-term rate allow growth to taper. Explicit tender, valuation, May grant, quarterly 409A and quarterly vest-FMV overrides take precedence.

Grant conversion price determines share count. Quarterly 409A determines QCA share count. Vest FMV determines modeled compensation and tax basis, defaulting to 409A; confirm this against vest statements and override if needed. Tender price values holdings and eligible sales. These prices are separate even when equal.

## Projection integration

`normComp` is the shared source used by `run` for stock compensation. Its annual stock output sums vest shares × vest FMV, including overlapping grants. Manual `normStockY*` inputs are inactive while grant mode is enabled. Cash compensation is the original cash baseline less any explicit existing QCA allowance plus calculated QCA cash. The allowance avoids adding QCA twice to older cash estimates.

Annual taxes use full-year compensation. In the observed start year, only future vest events are added to holdings, and QCA cash is timed to its remaining payments. Other cash income and expenses retain the annual engine's stub-year convention. Unknown past vests still affect estimated annual tax liability.

Net shares are valued at the tender mark; basis stays at vest FMV after withholding. A sale above basis incurs modeled capital-gains tax. Post-vest appreciation is not W2 compensation. Starting vested Stripe value remains a separate user input; unvested grants do not enter current net worth.

In grant mode, QCA cash is not also offered as a mechanism to sell arbitrary stock. February tender capacity excludes March vests. The existing Q4 tender assumption is an end-of-quarter window. The engine remains an annual cash-flow model: its separate home-funding monitor checks quarter-level sale availability; it is not a daily brokerage or payroll ledger. Same-year sales use an aggregate proportional cost basis and the existing planner capital-gains-rate assumption, not a complete short/long-term tax-lot optimizer.

Rolling the plan preserves calendar-year grants and historical price anchors. Saved scenarios hold their own configuration; editing one replaces nested configuration objects and does not mutate other saved scenarios. Monte Carlo reuses the deterministic grant ledger across diversified-portfolio trials.

## Verification

738 automated tests pass, including 23 new grant/math/workspace tests. Independent arithmetic covers fixed May share counts, PEG overlap, price appreciation, annual elections spanning March, quarterly 409A, actual/partial/remaining schedules, scenario isolation, cash allowance reconciliation, vest FMV versus tender value, tax basis, valuation ceiling/dilution, rollover and February eligibility. Existing tests also cover protected static routes for the new scripts.

Browser installation timed out in this environment. Workspace rendering and mutation handlers were exercised in a VM, but desktop/mobile visual verification remains outstanding.
