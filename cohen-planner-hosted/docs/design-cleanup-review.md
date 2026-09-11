# Design cleanup review — September 11, 2026

Scope: preserve the existing visual system and calculations. Review all six top-level tabs and all thirteen subtabs (sixteen distinct screens).

| Screen | Finding and disposition |
|---|---|
| Cockpit | Removed two advisor starters that repeated the home and exposure shortcuts. Kept general question and free-form entry. |
| Decisions / Explore | Shortened stacked headings. Kept the timeline, controls, preview comparison and save flow. Corrected outdated explanatory net-worth composition text. |
| Decisions / Housing | Kept the two funding constraints and preview/apply distinction. Shared mobile input and focus treatment applies; refinance remains folded. |
| Decisions / Key levers | Gave chart a bounded container; moved repeated amount grid and editable steps into a disclosure with horizontal scrolling. |
| Decisions / Compare | Replaced stale empty-state instructions with a working Explore action; made current-plan heading readable; removed fixed 2058 labels from final-year metrics. |
| Trajectory / Net worth | Separated nominal/real, range and band display controls from subtab navigation. |
| Trajectory / Income & tax | Shared display toolbar; clear previous screen summaries before rendering. Existing chart and breakdown retained. |
| Trajectory / Cash flow | Same toolbar and summary reset; existing series and funding information retained. |
| Trajectory / Table | Sticky header/year column, bounded scroll area, explicit retirement exclusion on existing final column. |
| Stripe | Annual vest reference and lifetime totals folded. Selected-year lead, vest flow, tender math and warning messages retained. |
| Financial Life / Overview | Existing collapsible accounts retained. Improved wrapping of account metadata. |
| Financial Life / Spending | Three repetitive import buttons replaced by one duration selector plus Import. Sync/error states retained. |
| Financial Life / Holdings | Previous single-donut/compact-mix cleanup retained; shared focus and mobile control polish applies. |
| Financial Life / Goals | Renamed navigation to match broader contents; seven long general planning suggestions folded; small-screen metric grids wrap. |
| Financial Life / Watchlist | Readable update timestamp with exact value on hover. Coverage and warning messages retained. |
| Advisor | Removed redundant absolute claim about generated figures. Kept projection source, horizon and value. Shared mobile input sizing applies. |

Cross-screen: shorter subtab labels, logical finance order, distinct chart controls, keyboard focus, mobile inputs at 16px, bounded overflow menu, stale summary prevention.

Verification: 715 existing tests pass; inline JavaScript syntax and whitespace checks pass. Two assertions were updated for intentionally revised display text. No model, server, schema, or saved financial parameters changed. Browser preview could not run: no browser executable was available, and its download timed out. Visual desktop/mobile verification remains outstanding.
