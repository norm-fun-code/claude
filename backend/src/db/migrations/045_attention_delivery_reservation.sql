-- Atomic delivery reservation for the Attention Policy.
--
-- Before this, notify/dispatch.js read the budget/cooldown snapshot, judged,
-- PUSHED, and only THEN recorded the ledger row (store/attention.js record()
-- took an advisory lock around the final insert alone). Two concurrent
-- dispatchers — an overlapping scheduler tick, two Railway replicas, a manual
-- run racing a cron — could each read "not surfaced / under budget", both send
-- the same push, and both insert. The same gap let two concurrent events each
-- pass a budget check that only had room for one.
--
-- Delivery is now a two-phase reserve → push → finalize commit:
--   1. reserveDelivery(): inside ONE serialized transaction (a single
--      cluster-wide advisory lock, held on the shared Postgres server so it
--      spans replicas) recheck cooldown + daily budget + critical reserve
--      counting in-flight 'reserved' rows, then insert a 'reserved' row.
--   2. The external push happens OUTSIDE that transaction (no long-held txn
--      across a network call).
--   3. finalizeDelivery(): mark the row 'delivered' | 'failed' | 'skipped'.
ALTER TABLE attention_log
  ADD COLUMN IF NOT EXISTS delivery_state    TEXT NOT NULL DEFAULT 'stored',
  ADD COLUMN IF NOT EXISTS delivery_attempts INT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reserved_at       TIMESTAMPTZ;
--   delivery_state:
--     'stored'    — judged, nothing to deliver (store_silently, update_belief),
--                   or surfaced through a non-push channel (add_to_brief,
--                   ask_question) whose delivered_channel records the channel.
--     'reserved'  — a push slot claimed inside the lock; delivery in flight.
--     'delivered' — push sent (delivered_channel = 'push').
--     'failed'    — push attempted and errored; retry-eligible (see below).
--     'skipped'   — reservation released without a push: dry run, no device,
--                   lost a budget/cooldown recheck, or retries exhausted.

-- Backfill historical rows so budget/cooldown queries that key off
-- delivery_state see consistent state. Pre-migration rows never went through
-- the reservation path — this is best-effort classification for continuity.
UPDATE attention_log SET delivery_state = 'delivered'
  WHERE delivered = true AND delivery_state = 'stored';

-- The cross-replica guarantee that the SAME fact is pushed at most once: at
-- most one live (reserved OR delivered) row per event_key. A 'failed',
-- 'skipped', or 'stored' row does NOT occupy this slot, so a failed push stays
-- retry-eligible and an audit row never blocks a real delivery. event_key
-- already carries a time bucket (day/week/month — see intelligence/events.js),
-- so this is naturally scoped to the fact's surface-dedup window, not forever.
CREATE UNIQUE INDEX IF NOT EXISTS attention_log_one_live_delivery
  ON attention_log (event_key)
  WHERE delivery_state IN ('reserved', 'delivered');
