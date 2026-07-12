-- Acceptance tracking for THE ACTION (full-repo review, improvement #3: the
-- brief's highest-leverage action was pure narration — no way to act on it,
-- and no record of whether the user ever took it up). accepted_at is stamped
-- when the user taps "Commit" on the brief's ACTION, turning the ledger from
-- outcome-only ("did it move the metric?") into acceptance + outcome ("did
-- they even take the suggestion — and then did it work?").
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
