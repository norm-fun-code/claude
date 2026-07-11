-- Forecast calibration ledger — the running record of "yesterday's tomorrow-
-- forecast vs what actually happened". The brief already computed this
-- comparison every morning (routes/briefing.js's CALIBRATION CHECK) but threw
-- it away after building one ephemeral prompt line: no history, no hit rate,
-- and forecast confidence never learned from its own track record. One row per
-- forecast day, written at comparison time; first comparison of the day wins.
CREATE TABLE IF NOT EXISTS forecast_calibration (
  day             DATE PRIMARY KEY,   -- the day that was forecast (comparison day)
  predicted_band  TEXT,
  predicted_score REAL,
  confidence      REAL,               -- the confidence the forecast CLAIMED (45-85)
  actual_band     TEXT,
  actual_score    REAL,
  hit             BOOLEAN,            -- band match
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
