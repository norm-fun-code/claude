# Cohen Family Planner

The existing Railway application, extended with a Decision Room home view.

## Decision Room

- Highlights the plan's monthly margin, pre-closing liquidity buffer, lowest liquid balance and tightest cash-flow year.
- A year scrubber connects projected finances with family milestones.
- Five what-if inputs can be combined: home budget, purchase year, childcare, practice capacity and portfolio return. Presets reset the preview to one starting choice; sliders then compose changes.
- A second trajectory and comparison table recalculate using `public/model.js`. The preview never assigns to the current plan.
- Saving creates a separate scenario only after the API confirms success. An advisor handoff prepares an editable question; the user sends it.
- Existing detailed views, saved scenarios and advisor conversations remain available. The first v6 load opens Decision Room; subsequent loads restore the saved view.

## Development and verification

```sh
npm ci
npm test
npm run dev
```

`npm run dev` starts an **offline UI preview** on port 4173 using repository default assumptions and in-memory saves. It makes no Monarch or AI calls and requires no database or credentials. `/qa/mobile` provides a 390px iframe for responsive inspection. Nothing in the preview is saved to production.

`npm run dev:server` retains the original development server with its normal database and environment configuration. `npm start` is the unchanged Railway production entry point. The offline preview is never mounted by `server.js`.

## Data integrity

Planner writes are debounced and serialized, check HTTP status, and cannot run until the initial state loads successfully. New assets use the existing session gate. Invalid or empty Monarch account responses are rejected rather than interpreted as zero balances; valid previous snapshots remain available. Legacy all-zero snapshots without account evidence are treated as unavailable. This does not guarantee that an upstream Monarch outage or schema change is resolved.

The existing financial engine is unchanged. Decision Room labels distinguish future dollars, inflation-adjusted dollars, modeled 401k, liquid investments, annual cash flow and the separate down payment. Closing buffers exclude closing costs and sale taxes. The model continues income/contributions through the plan horizon and is not a retirement drawdown model.

Hard-coded claims that a particular home budget requires a liquidity event, or buys a particular size home, have been replaced with conditional model results and explicitly illustrative comparisons.

## Validation in this change

- 46 automated tests: existing model regressions, scenario isolation, first-year/out-of-horizon purchases, practice ramp consistency, Monarch response validation, save failures/recovery and write ordering.
- Desktop and 390px browser inspection; combined what-ifs, year navigation, successful scenario save/Compare and prepared advisor question.
- Production server smoke check confirms all three new assets redirect unauthenticated requests to login.
- Live site walkthrough completed before changes. Production Monarch sync and AI generation require validation after deployment; no production parameter changes or advisor messages were sent during QA.
