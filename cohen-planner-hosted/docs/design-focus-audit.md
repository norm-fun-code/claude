# Planner focus audit — September 15, 2026

Purpose: reduce repetition without changing calculations, integrations or saved financial inputs.
Reviewed all six main sections and their 18 views, using live navigation, source inspection and
local DOM rendering. Keep each main section: each serves a distinct task.

| View | Decision |
| --- | --- |
| Cockpit | Retain balances, trajectory, priorities and shortcuts. Remove the second advisor composer; keep a direct advisor entry. Remove the repeated distant-wealth amount in the navigation rail. |
| Decisions / Explore | Lead with the what-if controls and outcome. Move baseline metrics and life timeline into an expandable reference below the workspace. Keep preview/save isolation. |
| Decisions / Housing | Keep buying range, controls, purchase-year matrix and funding check visible. Fold the secondary rate/down-payment matrix. |
| Decisions / Key levers | Keep: the ranked sensitivity chart already gives a distinct answer, with step sizes folded. |
| Decisions / Compare | Keep: cross-scenario outcomes and input differences are useful comparisons, not duplicate dashboards. |
| Trajectory / Net worth | Keep the chart and display controls. Replace repeated Home/Tax/Per-kid footer cards with one assumptions disclosure. |
| Trajectory / Income & tax | Same footer consolidation; keep the distinct income/tax chart. |
| Trajectory / Cash flow | Same footer consolidation; keep the distinct funding chart. |
| Trajectory / Table | Keep complete annual calculations as the dedicated audit view. |
| Stripe / Position | Fold the 33-year equity ledger. Consolidate three explanatory footer cards and remove the repeated mode banner. Keep vesting and concentration information. |
| Stripe / Compensation | Remove the duplicate heading and repeated implementation explanation. Retain all annual fields and the recent in-place editing/focus fix. |
| Stripe / Valuation path | Let the chart lead; exact scenario/year values become expandable. Preserve inputs in billions and the existing hover readouts. |
| Financial life / Accounts | Rename Overview to Accounts. Keep four observed balance tiles; remove projected cash flow and distant net worth. Fold the account register initially, connection metadata and matching reconciliation. Keep material differences and missing-data notices prominent. Remove the repeated next-actions list. |
| Financial life / Spending | Keep pace, rolling averages and visual breakdowns. Move ledger classifications and exclusions beneath them in a disclosure; remove roadmap text. |
| Financial life / Holdings | Keep the allocation donut and period movers. Fold secondary asset-class composition and narrative context. Route account administration to Accounts instead of repeating its register. |
| Financial life / Goals | Remove repeated snapshot/pace dashboard, plan highlights and static generic planning advice. Retain home funding, tuition and reserves. Fold mortgage mechanics and risk simulation; link to Housing and Watchlist for detailed decisions and screened opportunities. |
| Financial life / Watchlist | Keep actionable signals and failed-check warnings visible. Fold the explanations of unavailable checks while keeping their count in the summary. |
| Advisor | Keep the existing conversation surface; the cockpit now routes here instead of duplicating a composer. |

Validation: full existing suite; all 18 views rendered using local sample data with a mocked
chart renderer. Populated data paths and live post-deployment appearance checked separately.
No financial engine changes. Removed duplicated advice is superseded by the existing screened
opportunities, not by a new advice mechanism.
