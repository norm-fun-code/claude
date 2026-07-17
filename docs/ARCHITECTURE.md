# NormOS — Architecture

NormOS is a personal intelligence platform: a system that **accumulates** your
life data across domains, **discovers relationships** in it, and tells you the
highest-leverage action to take next. It is not a dashboard that re-fetches and
forgets — it is a data spine that remembers, with intelligence and presentation
layered on top.

## The core decision: persistence first

The original app generated a briefing on each load and discarded the data.
Everything in the NormOS vision — trends, correlations ("sleep vs productivity"),
forecasting, weekly/quarterly reviews, hypothesis tracking — is impossible
without history. So the foundation is a database that every connector writes into,
*then* renders on top of.

## Layers

```
┌─────────────────────────────────────────────────────────┐
│  5. PRESENTATION   Mobile app · Web · AI chat · Briefings │
├─────────────────────────────────────────────────────────┤
│  4. AGENTS         Coach · Strategist · Analyst (pluggable)│
├─────────────────────────────────────────────────────────┤
│  3. INTELLIGENCE   Correlations · Trends · Forecasts ·     │
│                    Hypotheses · Knowledge graph            │
├─────────────────────────────────────────────────────────┤
│  2. STORAGE        Time-series metrics + documents +       │
│                    vector store (the memory)               │
├─────────────────────────────────────────────────────────┤
│  1. INGESTION      Connectors → normalized events          │
└─────────────────────────────────────────────────────────┘
```

### Key design principle — one canonical schema

Every numeric observation, from any domain, becomes a row in **one** table:

```
metrics(ts, domain, metric, value, unit, source, metadata)
```

Because health, wealth, productivity, and environment all share this shape,
cross-domain correlation is a *query*, not a new integration each time. Text-bearing
content (books, highlights, notes, newsletters, calendar items) lands in
`documents` with vector embeddings for semantic search and the knowledge graph.

### Central state layer — one versioned brain above the domain authorities

Every surface (Today, Health, Wealth, Ask, realtime voice, the daily briefing +
scoped Chief Brief rebuild, forecasts, the evening review, watcher/notification
payloads) reasons about the *same* underlying facts: today's recovery, the
effective workout, open goals and commitments, month-to-date spend, the day's
forecast, eligible current context. When each surface independently re-derived
those facts from raw stores, they drifted — the Health tab showed a fresh
recovery score while Today rendered a forecast built from the old one; realtime
voice narrated a static workout the Health tab had already downgraded; a
retracted note still moved tomorrow's forecast. The **central state layer**
(`backend/src/brain/`) exists to make that drift structurally impossible.

**Domain authorities own computation.** Each canonical fact has exactly ONE
authoritative selector — the only place allowed to compute it:

| Fact | Authority (selector) |
|---|---|
| recovery (score/band/proxy) | `intelligence/recovery.liveRecovery` |
| effective workout | `services/workout.getEffectiveWorkout` (override > auto-downgrade > schedule) |
| today's forecast | `intelligence/predict.computeTodayForecast` |
| goals / weekly intention | `store/goals.listGoals` · `store/intentions.currentIntention` |
| open commitments | `store/commitments.listActive` |
| wealth / MTD discretionary spend | `services/wealth-insights.buildWealthInsights` · `brain/snapshot.canonicalSpendingMtd` |
| findings / trends | `store/findings.listFindings` |
| experiments | `store/experiments.listExperiments` |
| eligible current context | `store/annotations.overlapping` + `intelligence/context-semantics.filterEligible` |

**`brain/registry.js`** is the declarative field-authority + dependency graph:
for every fact it records its authority, what it `dependsOn`, which change
`TRIGGER`s invalidate it, its TTL, and whether it's live-refreshable.
`invalidationSet(trigger)` returns the transitive closure a change must
recompute — e.g. a recovery change invalidates `effectiveWorkout`,
`todayForecast`, and `recoveryComposite` *together*, so no surface can serve a
stale derived value beside a fresh input. This makes "recovery changed →
todayForecast is now stale" a **checked invariant**, not a comment someone has
to remember.

**`brain/invalidation.js`** is the runtime bus that makes that graph *act*: on a
mutation the write path calls `bump(TRIGGER)`, which walks `invalidationSet`,
increments each affected field's version + a global state version, and fires
registered side-effect listeners (e.g. clearing the `liveRecovery` compute
cache). Versions are **durably persisted** to the `brain_state_version` table
(fire-and-forget write-through from `bump()`, best-effort — a missing/unreachable
DB degrades to in-process-only, same as before the table existed) so this is
NOT silently process-local: `await refresh()` pulls the authoritative row set
and merges it into the in-process cache by `max()`, which is what lets a second
instance (or this same process after a restart) converge on a bump another
process made. It is wired into the real mutation sites — `store/metrics.js`'s
`insertMetrics` (the ONE write funnel every connector goes through: a normal
Eight Sleep sync now bumps `recovery_change` whenever the score materially
moves, not just the manual self-report route), the workout-override route +
`applyRestDayOverride`, `recomputeWealthFlows`, and the
goals/commitments/annotations/weekly-intention stores — so a change anywhere
drives the same declared invalidation instead of a hand-copied "also refresh X"
list. The briefing's cache-hit path is the canonical CONSUMER: it stamps
`fieldVersions` into every full-build response and, on the next cache serve,
calls `refresh()` then compares each tracked field's current bus version
against what was baked into the cache — refreshing precisely (and only) the
fields that moved, whether that movement came from recovery's own value
changing OR from an unrelated trigger (a workout override on a day with no
recovery reading, a transaction sync) that a pure value-diff could never see.

**`brain/snapshot.js` — `buildBrainSnapshot({asOf, tz, include})`** composes a
versioned `BrainSnapshot`: it calls each authority ONCE (independent reads run
concurrently; the forecast consumes the already-resolved effective workout so it
is never resolved twice per cut), tz-safe and deterministic under an injected
`asOf` (never `new Date()` for a boundary), and returns one structured object.
Every fact is wrapped with **provenance** — a 5-state `freshness`: `'fresh'`
(present, successful, within any declared TTL), `'stale'` (present but read from
a cache/computation older than the registry's TTL — currently meaningful for
`recovery`, checked against `liveRecovery`'s own cache timestamp, not the
snapshot's own cut time), `'valid-empty'` (the authority succeeded and an EMPTY
result is itself the correct, current answer — zero open commitments, no
running experiments), `'unavailable'` (skipped by `include`, or a
scalar/singular fact with genuinely no value — no HRV reading), and `'failed'`
(the authority THREW; always logged, carries `error`, never silently flattened
into an empty). `include` selects which non-core sections to compose, so the
realtime voice tool gets a lean cut (recovery + effective workout) without
paying for wealth/findings/experiments it won't read. The **full daily
briefing** cuts exactly ONE real snapshot — before it, `resolveWorkoutForPrompt`
and a standalone `buildWealthInsights()` call each independently re-resolved
the effective workout / wealth; now `workout` (the prompt-facing shape) and
`wealthInsights` are pure projections of the snapshot's already-resolved
`effectiveWorkout`/`wealth` — and derives its `todayForecast`, its LLM claim
facts, and its `snapshotId`/`snapshotAt`/`snapshotVersion` from that one cut —
the morning push forwards that same id, so an in-app view and its notification
are provably one cut of state. Thin projections (`realtimeTodayContext`,
`canonicalFacts`) shape that one snapshot for each consumer — they never
re-derive. `canonicalFactsFrom` is the single fact-shaping function both the
snapshot and the briefing hot path call. `realtimeTodayContext(snapshot,
briefing, {currentVersions})` additionally refuses to narrate a same-calendar-day
brief as current if its stored `fieldVersions` predate `currentVersions` (an
authoritative, `refresh()`-pulled read from the invalidation bus) — a date match
alone isn't enough; the brief must not have gone stale SINCE it was built,
even on the same day.

**Build lifecycle — nothing mutates canonical state after the cut.**
`recomputeWealthFlows()` runs BEFORE the snapshot is built (never after), and
the full build's remaining background work — a full multi-connector ingest,
`analyze()`, experiment evaluation, cross-context regeneration, proactive
nudges — is extracted into `primeNextBuildCycle()`, scheduled via
`setImmediate` strictly AFTER the response is built and the brief persisted, and
documented as priming the NEXT build/request, never feeding back into the one
just served. If that background ingest writes a recovery-relevant metric, it
goes through the same `insertMetrics` invalidation wiring above — so the
already-persisted brief is never rewritten, but the very next cache-hit read
detects the drift via `fieldVersions` and self-heals instead of silently
serving what's now wrong.

**`brain/claimValidator.js`** is the generalization of the goal-completion guard:
the LLM may choose emphasis and wording, but it may not create or recalculate
canonical facts. `validateChiefBriefClaims(result, facts)` deterministically
scans generated Chief Brief text for statements that *contradict* the snapshot's
values (recovery band/score, effective vs scheduled workout, goal/commitment
completion, experiment verdicts, spend totals) and drives a correction retry.
`neutralizeClaimViolations(result, violations, facts)` strips exactly the
offending sentence(s); `ensureRequiredFieldsPresent(result, facts)` is an
unconditional final backstop guaranteeing `synthesis`/`action`/`risk`/`move`
are never blank — if stripping every sentence in a field would leave it empty
(the field WAS the false claim, wholesale), a minimal, grounded, always-true
fallback sentence (built only from the facts the claim would have been checked
against) replaces it. A blank Chief Brief card is a worse failure than the
contradiction it replaces.

**Rule for new code:** a surface MUST NOT read a raw store (or re-run an
aggregation/resolution algorithm) to answer "what is the current value of X"
when an authoritative selector for X exists — call the selector, or read the
BrainSnapshot / a thin projection of it. Adding a competing derivation (a second
7-day trend, a duplicate recovery-resolution, a hand-rolled month-to-date sum)
is the regression this layer exists to prevent. If a genuinely new canonical
fact is introduced, give it ONE authority and register it in
`brain/registry.js` with its dependencies — do not scatter the computation
across call sites. Briefs, pushes, and addenda carry `snapshotId` /
`snapshotVersion` so an in-app view and its notification can be proven to
reference one cut of state.

## Storage

Self-hosted **Postgres + TimescaleDB + pgvector** — one database, three jobs:
relational data, time-series (hypertable + `time_bucket` aggregates), and vector
similarity. Runs locally via `docker-compose.yml`; your data never leaves your
machine.

Tables (`backend/src/db/migrations/001_init.sql`):

| Table | Purpose |
|---|---|
| `sources` | Registered connectors and their sync status |
| `metrics` | Canonical time-series spine (hypertable) |
| `documents` | Knowledge corpus + `vector(768)` embeddings (Gemini text-embedding-004) |
| `findings` | Intelligence-layer outputs (correlations, trends, risks, hypotheses) |
| `goals` | Tracked objectives, optionally bound to a metric for forecasting |
| `briefings` | Persisted daily / weekly / quarterly narratives |

## Ingestion

A connector implements
`{ id, domain, displayName, async sync(ctx) → { metrics, documents, config? } }`
and is registered in `backend/src/connectors/index.js`. The runner
(`backend/src/ingest/run.js`) executes every connector, persists results, and
records sync status. `ctx = { lastSyncAt, config }` enables incremental syncs;
a returned `config` patch (e.g. a Plaid cursor) is merged back into the source.

Three ingestion modes:
- **Server-pulled**: run on a schedule (`npm run ingest`) or via `POST /api/ingest/run`.
- **Device-pushed** (Apple Health): the mobile app POSTs HealthKit reads to
  `POST /api/ingest/health`, mapped to canonical rows in `backend/src/ingest/health.js`.
- **File-drop** (Monarch): export a CSV from Monarch and drop it into
  `backend/imports/monarch/`; the `monarch` connector auto-detects and imports it
  on the next `npm run ingest`, remembering processed files by content hash.

### Connectors

| Connector | Domain | Mode | Emits |
|---|---|---|---|
| `apple_health` | health | device-pushed | hrv, resting_hr, sleep_hours, steps, active_energy, vo2_max, body_fat, … |
| `monarch` | wealth | file-drop (monthly CSV) | net_worth/assets/liabilities + daily spending/income/net_cashflow + transaction documents |
| `plaid` *(dormant)* | wealth | server, incremental | net_worth/assets/liabilities/cash/investments + transaction documents — kept in code, unregistered, so it doesn't double-count Monarch |
| `readwise` | learning | server, incremental | highlight documents (Kindle, articles, podcasts) + sync counts |
| `notion` | learning | server, incremental | "wisdom" page documents + page counts |
| `google_calendar` | productivity | server | calendar_events, meetings + event documents |
| `weather` | environment | server | temperature, humidity, uv_index (context for correlations) |

**One authoritative wealth-flow calculation.** Every Monarch path that writes
`spending` / `spending_discretionary` / `income` / `net_cashflow` — the MCP sync
(`monarch-mcp-sync.js`), the GraphQL/CSV importer and the document recompute
(both via `monarch.js`'s `mapTransactions`), and the `/debug/wealth-income`
diagnostic — funnels through `monarch.js`'s **`reconcileWealthFlows`**. Total
expense and fixed housing come from the SAME netted transaction universe (a
positive refund nets its own category down, exactly as Monarch Reports does), so
`spending === fixed + discretionary` and `discretionary === spending − net fixed`
hold to the cent by construction — never by coincidence of two independently
filtered queries. Classification prefers Monarch's income-category NAMES, then
`category_type`, then a name heuristic (the CSV/recompute fallback). The MCP
sync no longer *writes* from `GetCashFlow`; it keeps it only as a logged
diagnostic cross-check (drift is surfaced, never silently blended in). This is
why a maintenance recompute can never overwrite metrics with different semantics
than the live sync — they are literally the same function.

## API surface

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness + DB readiness |
| `GET /api/briefing` | Daily briefing (also persists + triggers ingest) |
| `POST /api/ingest/health` | Push HealthKit metrics |
| `POST /api/ingest/metrics` | Generic canonical metric ingestion |
| `POST /api/ingest/run` | Run all server-side connectors |
| `GET /api/metrics?domain=&metric=&from=&to=&agg=` | Query a series (raw or daily-bucketed) |
| `GET /api/findings?status=` | Intelligence findings |
| `POST /api/analyze` | Run the intelligence layer (trends + correlations + leverage) |
| `POST /api/checkin` | Daily subjective check-in (mood/energy/focus + note) |
| `GET /api/actions` | Ranked highest-leverage actions |
| `GET /api/forecasts` | Goal achievement-probability forecasts (most at-risk first) |
| `POST /api/devices/register` | Register a phone's Expo push token for nudges |
| `GET /api/nudges` | Recent proactive nudges (the push log) |
| `POST /api/nudges/run` | Generate + send today's nudges (cron hits this) |
| `POST /api/chat` | Life chat — RAG answer over your data + library |
| `POST /api/embed` | Backfill document embeddings |
| `GET/POST /api/annotations` | Life context (travel, illness, deadlines) |
| `GET /api/experiments` | List self-experiments |
| `POST /api/experiments/propose` | Generate experiments from unconfirmed correlations |
| `POST /api/experiments/:id/start` | Start a proposed experiment |
| `POST /api/experiments/:id/evaluate` | Issue a verdict |
| `GET /api/sources` | Registered sources + sync status |

## LLM layer

`backend/src/llm/` is provider-agnostic so the model is a config choice, not a
rewrite:

- **Chat/reasoning** (`LLM_PROVIDER`): `anthropic` (Claude — default when
  `ANTHROPIC_API_KEY` is set) or `gemini`.
- **Embeddings** (`EMBED_PROVIDER`): `gemini` (text-embedding-004, 768-dim to
  match `documents.embedding`).

### Knowledge graph + life chat

`intelligence/embeddings.js` backfills embeddings for documents (run after
ingest, or `npm run embed`). `chat/ask.js` answers questions by fusing the
current findings, semantically-retrieved library documents (Readwise + Notion +
journal), and the question — grounded, with sources. The daily briefing uses the
same retrieval to surface the highlight most **relevant** to today's top action
(replacing the old random pick).

## Intelligence layer

`backend/src/intelligence/` turns the metrics spine into **findings**:

- `stats.js` — pure statistics (Pearson correlation, linear-fit slope, day
  alignment with lag, recent-vs-prior trend). No I/O, fully unit-tested.
- `catalog.js` — human labels + "direction of good" per metric, and per-metric
  daily aggregation (sum for flows like steps/meetings, avg otherwise).
- `analyze.js` — `computeTrends` / `computeCorrelations` (pure) + `analyze()`
  orchestrator that loads daily series, computes findings, and persists them.
- `forecast.js` — `forecastGoal` / `computeForecasts` (pure): projects each
  metric-bound goal's recent trend to its `target_date` and reports an
  achievement probability + projected crossing date.

**Forecasts (goal achievement probability):** for every active goal bound to a
metric, NormOS fits a least-squares trend over recent history, projects it to
the goal's `target_date`, and models the projected value as normally
distributed with uncertainty that grows with the horizon. The achievement
probability is `Φ` of the standardized gap to target (direction-aware, so
"lower is better" goals like body fat are handled correctly). Goals with no
date still get a projected crossing date; goals with too little history are
surfaced as `insufficient_data` rather than guessed. Forecasts are persisted as
`forecast` findings each analyze run and served most-at-risk-first at
`GET /api/forecasts`. The pure math (`stats.linearFit`, `stats.normalCdf`,
`forecastGoal`) is unit-tested under `backend/test/` (`npm test`).

**Trends:** per metric, compares the last 7 days' mean to the prior 7 and
reports material moves (≥10%), labeled improving/worsening by direction of good.

**Correlations:** all metric pairs over a 30-day window, Pearson at same-day and
1-day lag (e.g. last night's sleep → today's focus), keeping the strongest lag
where |r| ≥ 0.5 and n ≥ 10. Cross-domain pairs are flagged. Findings carry a
caveat that association isn't causation.

Each run supersedes the prior auto-generated findings (preserving history) and
writes a fresh set. The daily briefing surfaces the current open findings as
`insights`. Runs on demand (`npm run analyze` / `POST /api/analyze`) and
automatically after each ingest.

**Confirmation gate (trust):** a correlation is split in half; it's marked
`confirmed` only if it holds (same sign, |r| ≥ gate) on *both* halves — a holdout
guard against the multiple-comparisons trap. Only confirmed correlations become
leverage actions; unconfirmed ones become experiment proposals.

**Experiment loop (`intelligence/experiments.js`):** unconfirmed lever↔outcome
correlations become proposed self-experiments. When run, NormOS compares the
outcome during the test window to the baseline (Cohen's d + percent change) and
issues a verdict — confirmed / refuted / inconclusive. This closes the
"track whether hypotheses prove true" loop.

**Context layer (`store/annotations.js`):** life events (travel, illness,
deadlines) are recorded and fed into chat context so anomalies are explainable
rather than misread.

## Proactive nudges

NormOS doesn't wait to be opened. The nudge layer turns the current findings
into a short, ranked, push-based message — the "7am text" that makes it a chief
of staff rather than a dashboard.

- `intelligence/nudges.js` — **pure** `buildNudges`: maps open findings to
  candidate nudges (off-track/at-risk **forecasts**, the #1 **leverage action**,
  clearly **worsening trends**), scores their urgency, de-duplicates against
  what was recently sent (so a still-true insight doesn't nag every morning),
  and caps the count. `withinQuietHours` guards against off-hours pings.
- `notify/expo.js` — delivery via Expo's push service (APNs/FCM relay); the
  device's Expo push token is the credential, no secret key needed. Dead tokens
  (`DeviceNotRegistered`) are detected and deactivated.
- `notify/run.js` — `runNudges()` orchestrator: read open findings, build
  candidates, suppress repeats, persist to the `nudges` log, and push to every
  registered device. Run on a morning schedule via `npm run nudge`
  (cron/launchd) or `POST /api/nudges/run`. `--dry-run` previews without sending;
  `--force` overrides quiet hours.
- Storage: `devices` (registered Expo push tokens) and `nudges` (the send log,
  which doubles as the de-dup ledger) — `migrations/003_nudges.sql`.
- Mobile: `usePushRegistration` asks for permission, gets the Expo push token,
  and POSTs it to `/api/devices/register` on launch.

The judgement (which insight, how urgent, dedup, quiet hours) is unit-tested in
`backend/test/nudges.test.js`; only the network delivery needs a live device.

> As of the Attention Policy milestone (below), the *delivery decision* for the
> watchers, finding-driven nudges, wealth nudges, and check-in reminder is no
> longer made inside each producer — they build a normalized event and hand it
> to `notify/dispatch.js`, which runs the shared policy. `buildNudges` still
> does its own candidate construction and ranking; the policy is the layer that
> decides *whether and how* each candidate reaches the user.

## Attention Policy (unified judgment layer)

Every producer that used to decide *for itself* whether to interrupt the user
— a health/wellbeing watcher, the morning finding-nudge builder, wealth nudges,
the check-in reminder — now emits a **normalized event** and lets one shared
policy make the call. This is what stops the app from becoming N independent
notifiers that each think their signal is the important one.

- `intelligence/events.js` — **pure** adapters. Each producer already computes
  its own detection (a z-score, a budget-pace ratio, a finding rank); these
  translate that output into one `AttentionEvent` shape
  (`{source, domain, type, subject, signal:{magnitude,confidence,novelty},
  urgencyHint, action, critical, dedupBucket, …}`) without re-deriving the math.
- `intelligence/attention.js` — **pure** `judge(event, context)`. The single
  place that answers "what should NormOS do about this right now?" and returns
  exactly one of seven dispositions:
  `store_silently | update_belief | ask_question | add_to_brief | notify_now |
  offer_action | auto_act`. **Stage A** runs deterministic gates first
  (malformed → belief-routing → authorization/consent → critical-override
  validated against an allowlist → duplicate/cooldown); **Stage B** scores a
  conservative ladder (value × urgency − interrupt-cost). No LLM, no DB — every
  branch is a plain unit test (`test/attention-policy.test.js`).
- `notify/dispatch.js` — the **orchestration** layer, and the ONLY place the
  policy touches a database or the network. `dispatchEvent`/`dispatchEvents`
  build a `PolicyContext` from live ledger reads (recent keys, today's budget,
  consent grants, belief multipliers), call `judge()`, then execute. Batch
  dispatch tracks budget and event identity in-memory across the run so two
  candidates describing the same fact don't both surface.
- **Atomic delivery (reserve → push → finalize).** A push is a two-phase
  commit, not read-judge-send-record. `reserveDelivery()` runs a single
  serialized transaction — one cluster-wide advisory lock, held on the shared
  Postgres server so it spans Railway replicas — that **rechecks** the cooldown,
  daily budget, and critical reserve against committed state (counting in-flight
  `reserved` rows) and claims a slot. The Expo push then happens OUTSIDE that
  transaction; `finalizeDelivery()` marks the row `delivered` | `failed` |
  `skipped`. This closes the race where two concurrent dispatchers (overlapping
  scheduler tick, two replicas, a manual run vs. cron) both passed the same gate
  and double-sent or overshot the budget. A partial unique index
  (`attention_log_one_live_delivery`) is the backstop: at most one
  reserved/delivered row per `event_key`. A **failed** push leaves
  `delivered_channel` null so it does *not* start the cooldown — the next
  dispatch cycle retries it, capped at `ATTENTION_MAX_DELIVERY_ATTEMPTS` per fact
  per day so a persistently-failing push can't re-fire every run. Dry runs
  (`send:false`) reserve nothing and consume no budget.
- `store/attention.js` + `migrations/043_attention.sql` (+ `045_…_reservation.sql`)
  — the `attention_log` ledger: the policy's own decision/dedup/budget/audit
  trail, the `delivery_state`/`reserved_at` reservation columns, plus the
  outcome stamps (`dismissed`/`ignored`/`accepted`/`completed`) the beliefs
  layer learns from. The pre-existing `nudges` table is still written on every
  push so `GET /api/nudges` and other not-yet-migrated surfaces keep working.
- `store/consent.js` + `consent_grants` — explicit, per-capability
  authorization. `auto_act` is only reachable for an **internal**, **reversible**
  action with a matching grant; an **external** write is never auto-act-eligible
  (offer_action at most), regardless of grants.

**Identity & dedup.** `eventKey = domain:type:subject:bucket` (bucket =
day/week/month per event). This is the mechanism that collapses two *different*
producers describing the *same* fact onto one key — e.g. a wealth watcher and
the finding pipeline both flagging the same over-budget category.

**Cooldown vs. budget.** *Cooldown* suppresses the SAME fact (event_key) for N
hours after it was surfaced (any user-facing disposition, not just a delivered
push). *Budget* caps how many DIFFERENT facts may interrupt per day (only
push-delivered notify/offer/auto count). A small separate **critical reserve**
(`ATTENTION_CRITICAL_RESERVE`, default 1/day) is spendable only by events
matching the allowlist (currently an extreme respiratory-rate / resting-HR
anomaly); a reserve-exhausted critical event falls through to normal scoring
rather than being dropped.

**Learning loop.** Dismiss/ignore patterns from both the legacy wealth-insight
dismissal ledger and the new `attention_log` outcome stamps get promoted into
`dismissal_pattern` beliefs; `beliefs.beliefMultipliers()` then dampens (never
below a 0.4 floor) the value score of a repeatedly-dismissed subject on its next
appearance. Commitments feed this loop too — the commitments runner keeps its
own delicate delivery cadence (it is **audited, not gated** by the policy), and
the done/skip routes stamp the outcome so belief learning still sees it.

**Deferrals pay out in the brief.** Events the policy judges `add_to_brief` /
`ask_question` are surfaced to the next morning brief (via
`store/attention.pendingForBrief()` → an extra context block in
`generateChiefBrief`), so a deferred signal is folded into the narrative rather
than silently recorded and forgotten.

Env: `ATTENTION_DAILY_BUDGET` (default 4), `ATTENTION_CRITICAL_RESERVE`
(default 1). Migration: `043_attention.sql` (auto-applied by `npm run migrate`).

## Talk to NormOS (live voice, OpenAI Realtime)

The original voice flow (`routes/voice.js`'s `POST /voice/ask`) is a voice-memo
pipeline: record → upload → Gemini STT → `ask()` → Gemini TTS → download →
play. It still exists, unchanged, as the fallback path. "Talk to NormOS" is a
second, live mode: a persistent, interruptible, low-latency speech-to-speech
conversation over WebRTC, using OpenAI's Realtime API (`gpt-realtime-2.1`).

**Architecture — the mobile client connects to OpenAI directly.** The whole
point of an ephemeral client secret is that the backend never proxies live
audio: it mints a short-lived, scoped token; the phone negotiates its own
WebRTC session straight to OpenAI. This has one real consequence for where
code lives — **tool-call execution happens client-side**, because the
function-call event arrives on the mobile client's own data channel, not the
backend's. The mobile client relays it to our backend over a plain HTTP call,
gets the result, and sends it back to OpenAI over that same data channel.

- `services/realtime.js` — mints the ephemeral secret (`POST
  /v1/realtime/client_secrets`), with the session's `instructions`, `tools`,
  and semantic-VAD turn-detection (`interrupt_response: true`, the server-side
  mechanism that makes barge-in work — the model's own audio is truncated the
  instant the user starts talking over it) baked in at mint time. Model/voice
  are env-overridable (`REALTIME_MODEL`, `REALTIME_VOICE`).
- `chat/realtimeTools.js` — the tool layer: `get_today_context`,
  `get_current_recovery`, `get_active_goals_and_commitments`,
  `get_recent_findings`, `search_beliefs`, `query_metric`,
  `search_personal_library`, `execute_normos_action`, `deep_ask`. Every tool
  is a thin wrapper over an EXISTING store or brain — `execute_normos_action`
  reuses `chat/ask.js`'s own `validateAction` allowlist verbatim (the exact
  same actions typed/push-to-talk Ask already execute today, so this adds no
  new mutation surface), and `deep_ask` calls the unmodified `ask()` engine
  for anything needing real retrieval or cross-domain reasoning. `TOOL_NAMES`
  is the hard allowlist `routes/realtime.js` checks BEFORE this file is even
  consulted — a Realtime session can never reach an arbitrary backend function.
- `routes/realtime.js` — four endpoints, all behind the same `/api` auth as
  everything else: `POST /voice/realtime/session` (mint + compact personal
  context + tool schemas), `POST /voice/realtime/tool` (the client's tool-call
  relay point), `POST /voice/realtime/turn` (persists a completed turn to the
  SAME shared Ask conversation `chat.js`/`voice.js` write to — skipped for a
  `deep_ask` turn, which already persists itself), `POST /voice/realtime/metric`
  (client-observed latency: connect time, speech-end-to-first-audio, barge-in
  success, errors/reconnects — never raw audio).
- `store/realtimeMetrics.js` + `migrations/044_realtime_voice.sql`
  (`voice_realtime_events`) — the latency/usage ledger.
- Session context is compact by design: self-model, today's chief-brief
  synthesis/action, active life chapters, open commitments, this week's
  intention, current recovery band — NOT the full Ask prompt. Anything beyond
  that comes from a live tool call, so a stale session-start snapshot never
  substitutes for a fresh lookup.

**Mobile** (`mobile/src/lib/realtimeVoice.ts`, `mobile/src/components/
TalkOverlay.tsx`) — a `RealtimeVoiceSession` class owns the `RTCPeerConnection`,
the mic track, and the `"oai-events"` data channel: negotiates the SDP
exchange with OpenAI's `/v1/realtime/calls`, streams transcript deltas back to
the UI, relays tool calls to the backend and replies over the data channel,
and reports latency events. `TalkOverlay` is a calm, single-orb presence
indicator (listening/thinking/speaking/executing) with a live two-sided
transcript, mute/end/text-input controls, and an entry point next to
`AskOverlay`'s existing push-to-talk mic — the old path stays available
unconditionally as a fallback.

Guarded like every other native-module dependency in this codebase (mirrors
`lib/voice.ts`'s `expo-av` guard): `react-native-webrtc` is a NEW native
module the currently-shipped binary doesn't have. A top-level import would
crash old binaries on an OTA update, so the import is wrapped in try/catch and
`realtimeVoiceAvailable` gates the UI entry point — it stays hidden until the
next native (EAS) build ships. `EXPO_PUBLIC_REALTIME_VOICE_ENABLED` is a
second, independent staged-rollout flag on top of that.

Env (backend): `OPENAI_API_KEY`, `REALTIME_MODEL` (default
`gpt-realtime-2.1`), `REALTIME_VOICE` (default `cedar`), `VOICE_REALTIME_ENABLED`
(kill switch — `false` forces every client back onto the old Gemini
push-to-talk path with no redeploy). Migration: `044_realtime_voice.sql`.

## Roadmap

- **Phase 0 — Foundation (this milestone).** DB + canonical schema + connector
  framework; existing data now persists. ✅
- **Phase 1 — Ingestion breadth.** Readwise + Notion (learning), Plaid (wealth),
  Apple Health rounded out and persisted from the mobile app. ✅
  (Apple Health is the health source — no third-party wearables planned.)
- **Phase 2 — Intelligence.** Rolling trends + cross-domain correlations
  (incl. 1-day lag) written to `findings`; briefing surfaces them as insights. ✅
- **Phase 3 — Check-in + leverage engine.** 10-second mood/energy/focus
  check-in (the subjective signal) + the ranked "highest leverage action" engine
  (impact × confidence × ease) on the briefing front page. ✅
- **Phase 3.5 — Reviews & forecasting.** Goal achievement-probability forecasts
  shipped (`forecast.js` + `GET /api/forecasts`). ✅ (partial)
  Still open: weekly review and quarterly "board of directors" review narratives.
- **Phase 4 — LLM abstraction + knowledge graph + chat.** Provider-agnostic LLM
  layer (Claude/Gemini/Ollama), document embeddings, RAG life chat, and
  relevant-not-random highlight selection. ✅
- **Phase 5 — Experiments + trust.** Hypothesis/experiment loop, correlation
  confirmation gate (holdout), and a context/annotations layer. ✅
- **Phase 6 — Forecasting + proactive nudges.** Goal achievement-probability
  forecasting (`intelligence/forecast.js`, `GET /api/forecasts`) **and** the
  proactive nudge engine + Expo push delivery (`intelligence/nudges.js`,
  `notify/`, `npm run nudge`, mobile push registration). ✅
  Remaining ops (needs hardware/creds): EAS/dev build for the push entitlement,
  registering a device, and a morning cron schedule.
- **Phase 7 — Judgment & Attention Policy.** One shared policy decides whether
  and how any detected signal reaches the user; watchers, nudges, wealth, and
  the check-in reminder route their delivery decision through it. Beliefs learn
  from recorded outcomes; deferrals surface in the brief. ✅
  (`intelligence/attention.js`, `intelligence/events.js`, `notify/dispatch.js`,
  `store/attention.js`, `store/consent.js`, `migrations/043_attention.sql`.)
- **Phase 8 — Talk to NormOS (live voice).** OpenAI Realtime + WebRTC
  speech-to-speech replaces the record-upload-STT-ask-TTS-download voice-memo
  flow with a persistent, interruptible conversation, hybridized with the
  existing Ask engine (`deep_ask`) so nothing about Ask's retrieval/reasoning
  quality is lost. ✅ (`services/realtime.js`, `chat/realtimeTools.js`,
  `routes/realtime.js`, `mobile/src/lib/realtimeVoice.ts`,
  `mobile/src/components/TalkOverlay.tsx`.) Old push-to-talk stays as a
  fallback pending a proven native build.
- **Future — Specialist agents.** Investment Analyst, Career Coach, etc. on the
  shared spine.

## Decisions on record

- **Hosting:** self-hosted (own machine / private VPS) — most intimate dataset
  you'll ever assemble; you own the database.
- **Start narrow and deep:** prove the architecture on one domain end-to-end,
  then replicate the pattern.
- **Model-agnostic AI layer:** Gemini today, but wrapped so the model can change.
