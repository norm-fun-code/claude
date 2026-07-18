-- Production Safety Gate (audit recommendation #1): this was previously a
-- DELETE run on every server boot (server.js), which mutated user-facing
-- data (the recommendation ledger) merely because the process restarted —
-- never something a container restart should do. One-time cleanup: the LLM
-- was mistagging Monarch query steps ("Pull Jan–Jun...", "Export...") as
-- <rec> recommendations; that generation bug is fixed, so this only ever
-- matches legacy rows and is a no-op on any environment that's already run
-- it once (tracked in schema_migrations — never re-applied).
DELETE FROM recommendations
 WHERE title ~* '^(pull|export|fetch|get|check|look|query|run|import|download|analyze|review|compare) ';
