# Watcher architecture — phase one, and the plan for phase two

NormOS reacts to new data through **domain watchers** that detect a
same-day-worthy signal and hand a normalized `AttentionEvent` to the Attention
Policy (`notify/dispatch.js`), which alone decides whether/how to interrupt.
This doc states honestly what is event-driven today and what is not, and specs
the generalization so a later change can finish it without re-discovering the
shape.

## Phase one (current)

| Domain | Detector | Trigger | Event-driven? |
|---|---|---|---|
| Health | `intelligence/watch.js` `runWatch()` | inline on each health ingest (`routes/health.js` — HealthKit, Eight Sleep, sleep) **and** the morning routine | **Yes** — post-ingest |
| Wellbeing | `intelligence/watch.js` `watchWellbeing()` | inline on a check-in write (`routes/checkin.js`) | **Yes** — post-write |
| Wealth | `intelligence/wealth-nudges.js` `runWealthNudges()` | **`ingest/run.js` post-ingest detector on a successful `monarch_mcp_sync`** + the scheduled 1pm/5pm poll (backstop) + the morning routine | **Yes (as of this change)** — post-ingest, with the poll now a backstop |

What phase one does **not** yet have (and does not pretend to):

- **No single domain-agnostic post-ingest event bus.** Health and wellbeing
  wire their detectors inline at their own write sites; wealth is wired through
  a small `POST_INGEST_DETECTORS` map in `ingest/run.js`. That map is the seed
  of the general hook, not the hook itself.
- **No source-of-truth / TTL registry for briefing fields.** There is no
  declared table of "field X is authoritative from source Y and goes stale
  after Z", so nothing systematically knows which briefing figures may be
  refreshed mid-day versus are fixed at build time.
- **No mid-day briefing addendum path.** A signal detected after the morning
  build either becomes a push or waits for tomorrow's brief; there is no
  lightweight "Since this morning…" addendum that amends the existing brief
  without rebuilding it.

## Phase two (spec — TODO)

1. **Normalized post-ingest event hook.** `runConnector` emits a
   `{domain, source, connectorId, metricsWritten, window}` event after each
   successful write. Domain detectors *subscribe* to it (a registry keyed by
   domain) instead of being called inline. Detectors return `AttentionEvent`s
   only — they never decide delivery (that stays with `dispatchEvent`). Migrate
   health and wellbeing onto it so all three domains share one path; keep the
   scheduled polls purely as backstops.

2. **Field source-of-truth + TTL registry.** A declarative table:
   `field -> { source, ttl, refreshable }`. The briefing builder consults it to
   know which fields it may recompute during the day. This is what lets an
   addendum refresh only genuinely-stale fields and prevents the same fact from
   surfacing as both a push and a duplicate addendum without explicit policy
   intent (route both through `dispatchEvent`, whose `event_key` dedup already
   collapses one fact across surfaces).

3. **"Since this morning" addendum.** A small builder that appends dated deltas
   to the already-built brief (not a full rebuild), gated by the TTL registry
   and the Attention Policy so it never repeats a fact already pushed.

Until phase two lands, treat `ingest/run.js`'s `POST_INGEST_DETECTORS` map as
the one place to add a new domain's post-ingest reaction, and keep every
detector routing through `dispatchEvent` so dedup/budget/cooldown stay central.
