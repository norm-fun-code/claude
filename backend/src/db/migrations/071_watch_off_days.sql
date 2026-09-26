-- Days the Apple Watch was not worn.
--
-- Wrist-sensed metrics (steps, active energy, exercise/mindful minutes) do not
-- go SILENT when the watch is off — they read near-ZERO, which is worse. A
-- genuine "you barely moved" day and a "the watch was on the charger" day are
-- indistinguishable in the spine, so an unworn day drags down step trends,
-- registers as an activity anomaly, and poisons any baseline computed over it.
--
-- Only EXCEPTIONS are stored. Wearing the watch is the default, so a day with
-- no row here was worn; toggling back simply deletes the row. That keeps this
-- table tiny and makes "worn" the state that needs no upkeep.
--
-- The metric rows themselves are never touched. This gates them at READ time
-- (see store/metrics.js), so the raw data stays intact and auditable and the
-- toggle is fully reversible — the same discipline the rest of the spine uses
-- for retracted context rather than deleting it.
CREATE TABLE IF NOT EXISTS watch_off_days (
  local_day   DATE PRIMARY KEY,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
