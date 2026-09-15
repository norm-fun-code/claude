# Current Stripe workflow: manual compensation

The Awards and grant-cutoff controls are retired. Stripe now has Position, Compensation,
and Valuation path. Annual cash includes all cash awards; annual stock is gross vest-date
compensation, including any pre-vest upside the user estimates. There is no extra income
multiplier. Retained after-tax stock enters holdings once; existing holdings appreciate
on the February tender calendar using the same valuation path as the chart.

Migration freezes effective annual cash/stock amounts from enabled grant plans, preserves
hybrid overrides and the archived grant configuration, and is idempotent. The first eleven
years use the original normCashY/normStockY fields; later explicit amounts use calendar-year
stripeManualLater entries. Unspecified later years grow from the latest explicit amount.
Saved cases are converted after reattaching shared facts, preserving their own assumptions.
The reference valuation, ceiling, dilution and existing price overrides remain in effect.
QCA cash belongs in cash compensation, not an assumed sale facility for vested PEG stock.

The remainder documents the archived grant engine for recovery and historical reference;
it no longer describes the normal user workflow.

---

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


## Hybrid compensation option (September 2026)

In Awards & elections or Compensation, select **Use grant model through**. New setups default to the first two plan years. Existing all-year grant plans are preserved until the user selects a cutoff; a one-click two-year option is offered. An absolute year stays fixed during annual roll-forward.

Through that year, actual/estimated grant schedules drive compensation. Later years use editable annual total cash and stock compensation, including all older PEG vests. Their grant schedules are not added again. Those years have no award-entry form; they link directly to manual compensation instead. Position valuation and the sale policy continue over the whole horizon.

On first selecting a cutoff, future annual income is copied from the grant projection into calendar-year manual entries. Subsequent grant/price edits do not change these manual inputs. Extending and shortening the cutoff preserves previously edited manual values. All-years grants and all-years manual options are available. Manual stock income is distributed over the existing quarterly vest dates for timing and translated using vest FMV; it does not require the user to supply shares. If quarterly FMVs differ, this equal-quarter approximation can differ from the old detailed grant timing.

Manual cash already includes salary, bonus and QCA; no extra QCA cash or existing-QCA deduction applies after the cutoff. The sidebar edits the same manual entries as the Stripe compensation table. Saved cases keep manual compensation assumptions while inheriting shared grant facts and the selected cutoff. Older cases without manual entries inherit the live manual schedule.

Nine new hybrid regression tests cover boundary behavior, prefill/reconciliation, price independence, zero inputs, round-trip edits, rollover, saved cases, all/manual options and ineffective legacy advisor edits. These and 25 pre-existing grant/model/scenario tests were executed in an isolated JavaScript runtime, along with seven workspace interaction checks and syntax checks. The normal development environment was unavailable, so the full Vitest suite and browser visual verification were not rerun for this change.
