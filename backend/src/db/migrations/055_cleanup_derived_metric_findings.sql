-- Production Safety Gate (audit recommendation #1): moved off server.js's
-- boot path (see 052's header comment). One-time cleanup: trend findings on
-- Eight Sleep DERIVED intermediates (sleep need/debt) and any correlation
-- involving them or VO2 max/respiratory rate leaked into the general
-- trend/correlation engines before being excluded; they're derived or
-- near-flat estimate series, so patterns like "higher VO2 max -> lower
-- sleep need" are noise, not physiology. No longer generated; this only
-- ever matches legacy rows already in the DB.
DELETE FROM findings
 WHERE (evidence->>'kind' = 'trend' AND evidence->>'metric' IN ('health:sleep_debt', 'health:sleep_need'))
    OR (evidence->>'kind' = 'correlation' AND (
          evidence->>'a' IN ('health:sleep_debt', 'health:sleep_need', 'health:vo2_max', 'health:respiratory_rate')
       OR evidence->>'b' IN ('health:sleep_debt', 'health:sleep_need', 'health:vo2_max', 'health:respiratory_rate')));
