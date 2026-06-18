const { query } = require('../db');

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
  return rows[0] ?? null;
}

async function updateGoal(id, { status, title } = {}) {
  const fields = [];
  const vals = [id];
  if (status !== undefined) { vals.push(status); fields.push(`status = $${vals.length}`); }
  if (title !== undefined)  { vals.push(title);  fields.push(`title = $${vals.length}`); }
  if (!fields.length) return;
  await query(`UPDATE goals SET ${fields.join(', ')} WHERE id = $1`, vals);
}

async function deleteGoal(id) {
  await query('DELETE FROM goals WHERE id = $1', [id]);
}

module.exports = { listGoals, createGoal, updateGoal, deleteGoal };
