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
| `GET /api/sources` | Registered sources + sync status |

## Roadmap

- **Phase 0 — Foundation (this milestone).** DB + canonical schema + connector
  framework; existing data now persists. ✅
- **Phase 1 — Ingestion breadth.** Readwise + Notion (learning), Plaid (wealth),
  Apple Health rounded out and persisted from the mobile app. ✅
  Next candidates: Oura/Whoop for health depth.
- **Phase 2 — Intelligence.** Rolling trends, first cross-domain correlations,
  the `findings` table populated; briefing reads from history.
- **Phase 3 — Reviews & forecasting.** Weekly review, quarterly "board of
  directors" review, goal achievement-probability forecasts.
- **Phase 4 — Agents & chat.** Conversational interface and pluggable specialist
  agents (Investment Analyst, Career Coach, ...) on the shared spine.

## Decisions on record

- **Hosting:** self-hosted (own machine / private VPS) — most intimate dataset
  you'll ever assemble; you own the database.
- **Start narrow and deep:** prove the architecture on one domain end-to-end,
  then replicate the pattern.
- **Model-agnostic AI layer:** Gemini today, but wrapped so the model can change.
