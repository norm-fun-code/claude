-- Health tab redesign (audit rec #4) — "Patterns & experiments" replaces the
-- raw NormOS Profile prose with a per-belief management surface (Confirm /
-- Edit / Retire / Forget). The existing active|retired status already covers
-- Retire; this adds the one missing bit — an explicit user confirmation —
-- so the UI can show 'confirmed' (user-affirmed) vs 'supported' (system
-- confidence only) without inventing a disputed/hypothesis state machine the
-- backend has no real signal for.
ALTER TABLE beliefs ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
