-- Durable, cross-instance store for brain/invalidation.js's field-version
-- bus. Before this, a mutation's bump(TRIGGER) only incremented an in-process
-- counter — correct within one Node process, but invisible to any sibling
-- instance (and lost on every restart), which is exactly the "silently
-- process-local" gap a multi-instance deployment would hit: instance A bumps
-- recovery_change, instance B's cached briefing has no way to learn its
-- derived fields are now stale. This table is the single source of truth;
-- invalidation.js keeps an in-process cache seeded/merged from it for fast
-- synchronous reads, but any consumer that needs an authoritative freshness
-- check calls invalidation.refresh() first, which reads this table.
CREATE TABLE IF NOT EXISTS brain_state_version (
  field text PRIMARY KEY,
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
