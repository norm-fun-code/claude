# Cohen Private Office · design brief

**Decision:** keep the five destinations. Change what earns the first screen. Each tab opens with one answer, one graphic that explains it and one useful next move. The visual reference is a beautifully typeset private-client statement: quiet, precise and personal.

## What the audit showed

Reviewed the production revision `2befdc6`, its client renderers, housing and spending calculations, Advisor history paths and regression suite. Walked the first screen of all five tabs in the offline preview, with a closer pass through Spending and Budget and the 390px layout. The preview uses sample data; findings are about the product, not the household's current finances.

- **The biggest obstacle is hierarchy.** On desktop, the global location comparison, a tab switcher, a headline and explanatory copy all preceded the first spending figure. On a phone those elements cost an even larger share of the screen. Put case and location together in one compact context button; the comparison editor belongs behind it. Hide the account status unless it needs attention.
- **Spending and Budget ask the user to reconcile two lenses.** Spending can include a partial current month; Budget compares a closed-month pace with a full-year plan. Both are useful. Give them different names and periods. Never compare a partial month to a full budget or silently switch the basis.
- **The overview sells its own analysis.** The sample opens with account balances, 33 years of grant-election bars, multiple funding gaps, a housing prompt and a watchlist signal. Keep the balances and select the single most material change or exception. Move multi-decade compensation analysis to Future.
- **Decisions has the strongest content and the weakest front door.** Its What-if landing page opens immediately inside financial independence, while Housing has a separate route and other decisions live in disclosures. Show the last active decision and direct entries to the others. Don't take a user to retirement analysis on the way to pricing a home.
- **Advisor offers overlapping ways to start.** Starter groups, three extra prompt buttons and a composer compete. Keep the composer and at most two suggestions tied to the current plan. Move history to a drawer and put draft actions beside the relevant answer.
- **Presentation code does unnecessary work.** Multiple wrappers rebuilt parts of rendered pages; the same plan was projected repeatedly. This cleanup shares the base projection with the presentation layer. Migrate one screen at a time to render its own final markup. Retain separate model runs for actual alternatives.

## The five screens

| Destination | Visible on entry | One step deeper |
| --- | --- | --- |
| Overview | Net worth with its basis; change since a comparable snapshot; one issue worth acting on. If there is no comparable snapshot, omit the change. | Tap the change for the accounts that drove it; tap the issue for its originating year or category. |
| Spending & Budget | Current year: spending against the budget for the same period. One horizontal list with actual amounts, budget markers and signed variances. Switch between **Largest spend** and **Largest overage**. Future year: planned monthly spend, largest driver and an upcoming unbudgeted cost if one exists. | Tap a category for transactions in actuals, or its assumption and year scope in the plan. Keep fixed bills on their payment schedule. Benchmarks, mappings and import diagnostics stay in Details. |
| Future | One timeline with a selected year; headline investable assets including vested Stripe, with a separate accessible-assets lens where liquidity is the question. Mark home purchase, peak tuition and the tightest cash year. | Tap a year for its income, spending and funding; the full Table opens at that year and preserves the dollar basis. |
| Decisions | Choose **Housing**, **Corporate exit** or **Compare cases**. Housing leads with all-in monthly cost and affordability; exit leads with lifetime funding and the first failed safety rule. Comparison shows the change from the selected case. | On Housing, price/rate/down payment sit beside the payment; rent vs. buy reveals break-even and cash to close. On exit, open guardrails, SS sensitivities and taxes. Previews remain separate until explicitly saved. |
| Advisor | One question field. If opened from another view, carry context in a small removable chip, e.g. “Housing · 2034.” | An answer links back to the relevant line or year; proposed edits show a before/after diff and a save action. |

## Visual direction

- **Color:** warm paper `#F6F4ED`, ink `#193A2E`, quiet rules `#D5D9CB`. Use forest for primary data, muted sage for comparisons and an ink outline for a budget marker. Reserve oxblood `#873F3B` for a material adverse variance. Pair it with “over” and a signed value. Use text or dashes for missing data, never a zero-height green bar.
- **Type:** a restrained serif such as Georgia for the one principal figure, not every card heading. System sans for navigation, controls and tables. Use tabular numerals, align decimals/units, and keep supporting labels readable on a phone. Drop generic slogans, decorative eyebrows and monospaced microcopy.
- **Layout:** one reading column and one dominant chart. Align the headline, plot and detail rows to the same left edge. Use whitespace and fine rules between sections. Give cards a border only when they group an action or a distinct comparison. Reserve dark forest for navigation and the selected control; skip gradients, glows and decorative animations.
- **Charts:** direct-label the last point of a line and the value of a bar. Use a dashed comparison, not a second similar shade. Preserve the user's selected year or category when opening and closing detail. No separate donut for data already ranked in a bar chart.
- **Mobile:** put the conclusion and its driver above the fold at 390px. Use a tap to open a detail sheet; restore focus and scroll when it closes. Desktop can use a side panel for the same content. Touch targets at least 44px; visible keyboard focus; respect reduced motion. Hover is an optional shortcut only.
- **Copy budget:** a number, its unit/period, one finding, one action. Sources, definitions, methodology and routine sync notes stay in Details. Surface a short exception such as “Data through Sep 10” only when it changes interpretation. An actual funding shortfall remains visible.

## Build order and release gates

1. **Build Spending & Budget first.** Create the shared time-period selector, comparison row and detail panel. Test with an in-progress month, rent paid on the first, a refund, missing categories and a future tuition peak. No data, zero and under budget must look different.
2. **Apply the hierarchy to Overview and Future.** Share case, location, year and dollar basis. Reconcile every headline to the same underlying model row or recorded aggregate; a drill-down must preserve them. Keep the exact numbers accessible.
3. **Reorganize Decisions and Advisor.** Preserve the full housing and FI tools, remove duplicate entry points, and carry context into and back from Advisor. Delete superseded DOM transformations and styles only after their replacement is exercised.

**Usability gate:** on phone and desktop, someone unfamiliar with the planner can name the largest over-budget category, find the tightest future year, and see the payment change from raising a down payment—each within ten seconds, without opening explanatory text. From each answer the underlying detail should be reachable in one interaction. These are acceptance targets for the redesign, not claims that it already meets them.
