// Weekly intentions: the Sunday check-in (life context + focus goals). Upserted
// one row per week (keyed on the Sunday date). The intelligence layer reads
// recent entries as rolling context for the advisor, review, and insights.
const { query } = require('../db');

/** The Sunday (local) that starts the week containing `date`. YYYY-MM-DD. */
function weekStart(date = new Date(), tz = process.env.TZ || 'America/New_York') {
  // Get the local Y-M-D and weekday, then back up to Sunday.
  const ymd = date.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay();          // 0=Sun..6=Sat
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Upsert the current week's intention (context + goals). */
async function saveIntention({ weekStart: ws, context = null, goals = [] } = {}) {
  const week = ws || weekStart();
  const clean = Array.isArray(goals)
    ? goals.map((g) => String(g).trim()).filter(Boolean).slice(0, 5)
    : [];
  const { rows } = await query(
    `INSERT INTO weekly_intentions (week_start, context, goals, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (week_start) DO UPDATE
       SET context = EXCLUDED.context, goals = EXCLUDED.goals, updated_at = now()
     RETURNING id, week_start, context, goals`,
    [week, context ? String(context).trim() : null, JSON.stringify(clean)]
  );
  return rows[0] ?? null;
}

/** The current week's intention, or null if not set yet. */
async function currentIntention() {
  const week = weekStart();
  const { rows } = await query(
    `SELECT week_start, context, goals FROM weekly_intentions WHERE week_start = $1`,
    [week]
  );
  const r = rows[0];
  return r ? { weekStart: r.week_start, context: r.context, goals: r.goals || [] } : null;
}

/** Recent intentions within `days` (rolling context for the intelligence layer). */
async function recentIntentions({ days = 30 } = {}) {
  const { rows } = await query(
    `SELECT week_start, context, goals
       FROM weekly_intentions
      WHERE week_start >= (now() - ($1::int || ' days')::interval)::date
      ORDER BY week_start DESC`,
    [days]
  );
  return rows.map((r) => ({ weekStart: r.week_start, context: r.context, goals: r.goals || [] }));
}

module.exports = { saveIntention, currentIntention, recentIntentions, weekStart };
