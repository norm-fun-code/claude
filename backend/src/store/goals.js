const { query } = require('../db');

// A goal create/update/delete changes what the brief's completion + weekly-intention
// language may claim — route through the ONE invalidation bus (registry: GOAL_CHANGE
// invalidates goals + weeklyIntention). Durable and awaited (not fire-and-forget):
// a goal write is user-facing-state the caller is about to confirm as saved, so a
// request that immediately hits a different instance must not observe stale goals
// (Transactional Brain Invalidation, audit recommendation #2, item 5).
//
// Deliberately UNGUARDED — no try/catch swallowing a failure here. bumpDurable()
// rejects (InvalidationPersistError) when the durable write-through genuinely
// fails; hiding that behind a blanket catch would let this function resolve
// as if cross-instance freshness were confirmed when it wasn't. The
// underlying goal write above already committed by the time this runs, so a
// caller that lets this rejection propagate (via asyncHandler → the central
// error middleware, same as any other thrown error) reports the true
// outcome — saved, but durable invalidation unconfirmed — rather than a
// false "everything's fine". Never retry the goal mutation itself from
// here: it already happened and is not safe to redo automatically.
async function invalidateGoals() {
  await require('../brain/invalidation').bumpDurable('goal_change');
}

async function listGoals({ status = 'active' } = {}) {
  const { rows } = await query(
    `SELECT id, title, domain, metric, target_value, unit, target_date, baseline_value, status, created_at
       FROM goals
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at DESC`,
    [status]
  );
  return rows;
}

async function createGoal({ title, domain = null, metric = null, targetValue = null, unit = null, targetDate = null, baselineValue = null } = {}) {
  const { rows } = await query(
    `INSERT INTO goals (title, domain, metric, target_value, unit, target_date, baseline_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [title, domain, metric, targetValue ?? null, unit, targetDate ?? null, baselineValue ?? null]
  );
  if (rows[0]) await invalidateGoals();
  return rows[0] ?? null;
}

/**
 * Invalidates only when a row was ACTUALLY changed — not merely matched.
 * The WHERE clause requires at least one of the given fields to genuinely
 * differ from what's already stored (IS DISTINCT FROM), so a no-op call
 * (an unknown id, or re-submitting the exact same status/title) never
 * bumps the durable version for nothing observable having changed.
 */
async function updateGoal(id, { status, title } = {}) {
  const setFields = [];
  const whereConds = [];
  const vals = [id];
  if (status !== undefined) {
    vals.push(status);
    setFields.push(`status = $${vals.length}`);
    whereConds.push(`status IS DISTINCT FROM $${vals.length}`);
  }
  if (title !== undefined) {
    vals.push(title);
    setFields.push(`title = $${vals.length}`);
    whereConds.push(`title IS DISTINCT FROM $${vals.length}`);
  }
  if (!setFields.length) return;
  const { rowCount } = await query(
    `UPDATE goals SET ${setFields.join(', ')} WHERE id = $1 AND (${whereConds.join(' OR ')})`,
    vals
  );
  if (rowCount > 0) await invalidateGoals();
}

async function deleteGoal(id) {
  const { rowCount } = await query('DELETE FROM goals WHERE id = $1', [id]);
  if (rowCount > 0) await invalidateGoals();
}

module.exports = { listGoals, createGoal, updateGoal, deleteGoal };
