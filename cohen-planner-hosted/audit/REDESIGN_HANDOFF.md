# Redesign handoff — compact context for Astra Medium

Repository `norm-fun-code/claude`, planner branch `claude/deploy-financial-planner-78esr`, app `cohen-planner-hosted`, hosted on Railway. Audit baseline `afbbaa19a1fedabb0f2637b4fff0187bfe425006`. Read `AUDIT_2026-09-11.md` first and verify corrections/current head. User wants redesign as a separate phase, after audit; do not confuse an audit with approval that financial outputs are reliable.

## Product direction agreed with Norm

An intelligent private family office: striking, polished, useful, calm. Deep ink surfaces, exceptional typography, restrained emerald/amber/violet, generous spacing, motion that explains state or consequences. Clear document/table treatments. Mobile is essential. No ornamental real-time effects or fabricated readiness/health scores.

The opening canvas answers: Where do we stand? What changed? What deserves attention? Lead with evidence-backed context and at most three priorities. Show accessible capital, cash-flow margin, commitments, and total wealth with liquidity/source distinctions. Planning allocations for Everyday Life / Family Reserve / Home / Long-Term Wealth must be explicit user allocations, never additional assets.

The main workspace adapts to a question: home affordability, spending variance, portfolio, or career. Keep familiar navigation and a contextual advisor alongside the evidence. Every recommendation should offer Show me why: source dates, assumptions, calculations, alternatives, and conditions that reverse the conclusion.

Scenario interaction: a persistent Current Plan / Exploring distinction. Changes to home timing or working hours should update coherent cash/reserve/stock-sale/future-wealth results. Show a compact change summary; application is deliberate and recoverable. Prototype one main cockpit screen before broad styling.

## Reuse map

| Existing boundary | Reuse / caution |
| --- | --- |
| `public/model.js` | Shared browser/Node projection engine. Fix audit issues first; do not duplicate finance math in UI. |
| `public/decisions.js`, `decision-room.js` | Scenario overrides, milestones, preview/compare chart, separate saved scenarios. |
| `public/accounts.js`, `snapshots.js` | Account metadata, provenance, reconciliation, wealth history. Normalize missing/stale data and matching scopes first. |
| `public/spending.js`; `monarch-sync.js` | Classification/ledger and rolling summaries. Need verified coverage and completed budget UI. |
| `public/liquidity.js` | Funding-window helpers; must share assumptions and net funding math with projection. |
| `public/monitors.js`, `inbox-state.js` | Deterministic detection, priorities, snooze/dismiss, briefing state. Resolve audit findings before presenting an all-clear. |
| `public/tax-rules.js`, `tax-plan.js` | Rule citations and review shapes. Rule metadata is not proof the engine applies it; payment logic needs repair. |
| `public/advisor-tools.js`, server advisor routes | Validated tool shapes and proposal concepts. Complete structured SSE, persistence, and review wiring. |
| `public/index.html` | Large inline UI (~5,600 lines): `render`, `setTab`, `renderOverviewTab`, `renderWatchTab`, `renderSpendingTab`, `renderHousingTab`, advisor stream/proposal handlers. Extract UI components gradually at these seams, preserving behavior. |
| Database/routes | Keep existing scenario/chat/planner-state APIs and serialized saving. Preserve IDs and state migrations. |

Current top-level navigation is Decision Room / Projection / Stripe / Today / AI Advisor, with nested views. Today contains several pieces the cockpit will compose; avoid creating a second account or projection state store. Use one normalized view model, keep source/loading/error states independent, and centralize request freshness/coalescing so compositing cards does not multiply upstream calls.

## Interaction gaps that design must not hide

Budget/recurring workflows, job-offer evaluation, tax-document review, structured decisions, and saved generated briefings are not all delivered. Treat them as explicit functional work with acceptance criteria. A new shell cannot make an unavailable tool work.

Norm confirmed Coinbase is empty ($0); represent a dated, account-specific user confirmation distinct from a provider observation. Do not generalize missing balances to zero.

Minimum acceptance before final visual rollout: mobile navigation and readable tables; actual-vs-projected labels; complete/partial/stale states; scenario preview/apply/save/reload; advisor evidence/proposal review; no duplicate balances or hidden live errors. Keep production integrations and current plan untouched by previews.
