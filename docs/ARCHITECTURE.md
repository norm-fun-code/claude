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

Two ingestion modes:
- **Server-pulled**: run on a schedule (`npm run ingest`) or via `POST /api/ingest/run`.
- **Device-pushed** (Apple Health): the mobile app POSTs HealthKit reads to
  `POST /api/ingest/health`, mapped to canonical rows in `backend/src/ingest/health.js`.

### Connectors

| Connector | Domain | Mode | Emits |
|---|---|---|---|
| `apple_health` | health | device-pushed | hrv, resting_hr, sleep_hours, steps, active_energy, vo2_max, body_fat, … |
| `plaid` | wealth | server, incremental | net_worth/assets/liabilities/cash/investments metrics + transaction documents |
| `readwise` | learning | server, incremental | highlight documents (Kindle, articles, podcasts) + sync counts |
| `notion` | learning | server, incremental | "wisdom" page documents + page counts |
| `google_calendar` | productivity | server | calendar_events, meetings + event documents |
| `weather` | environment | server | temperature, humidity, uv_index (context for correlations) |

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
  `ANTHROPIC_API_KEY` is set), `gemini`, or `ollama` (fully local).
- **Embeddings** (`EMBED_PROVIDER`): `gemini` (text-embedding-004) or `ollama`
  (nomic-embed-text) — both 768-dim to match `documents.embedding`.

Privacy: point both at `ollama` and your most sensitive analysis never leaves
the machine.

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

## Roadmap

- **Phase 0 — Foundation (this milestone).** DB + canonical schema + connector
  framework; existing data now persists. ✅
- **Phase 1 — Ingestion breadth.** Readwise + Notion (learning), Plaid (wealth),
  Apple Health rounded out and persisted from the mobile app. ✅
  Next candidates: Oura/Whoop for health depth.
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
  forecasting engine done (`intelligence/forecast.js`, `GET /api/forecasts`,
  surfaced in the analyze run). ✅ (forecasting)
  Next: push notifications that deliver the right insight at the right moment.
- **Future — Specialist agents.** Investment Analyst, Career Coach, etc. on the
  shared spine.

## Decisions on record

- **Hosting:** self-hosted (own machine / private VPS) — most intimate dataset
  you'll ever assemble; you own the database.
- **Start narrow and deep:** prove the architecture on one domain end-to-end,
  then replicate the pattern.
- **Model-agnostic AI layer:** Gemini today, but wrapped so the model can change.
