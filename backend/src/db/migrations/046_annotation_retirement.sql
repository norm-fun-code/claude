-- Context-relevance/retraction fix (see intelligence/context-semantics.js).
--
-- Bug: a user's explicit retraction ("I didn't end up going for drinks with
-- friends tonight. Please forget that context.") got saved as a new active
-- annotation and then narrated as a possible cause of an elevated resting-HR
-- anomaly. Two parts to the fix:
--
--   1. retired_at/retired_reason — when a NEW annotation is classified as a
--      retraction (see context-semantics.js's classifyEventKind), the store
--      layer conservatively looks for the specific PRIOR annotation it's
--      walking back and marks it retired here — never deleted, so the audit
--      history stays intact, but excluded from every intelligence consumer
--      (annotationsStore.overlapping() now filters retired_at IS NULL).
--
--   2. Existing contaminated findings: any already-persisted 'anomaly'
--      finding whose detail was built by the old unconditional
--      "(Context: ... — may explain this deviation.)" annotation-attachment
--      logic is superseded here so it stops showing on the Health tab
--      immediately on deploy, without waiting for the next scheduled
--      analyze() run. The next analyze() run regenerates anomaly findings
--      from scratch with the corrected eligibility/temporal-alignment rules
--      (and the new "(Possible contributor: ...)" phrasing), so this is a
--      one-time invalidation, not a permanent hole — normal findings
--      lifecycle (supersedeAuto in intelligence/analyze.js) takes over from
--      here.
ALTER TABLE annotations ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
ALTER TABLE annotations ADD COLUMN IF NOT EXISTS retired_reason TEXT;

UPDATE findings
   SET status = 'superseded'
 WHERE status = 'open'
   AND detail LIKE '%may explain this deviation%';
