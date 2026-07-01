// Persisted briefings/reviews (daily | weekly | quarterly narratives).
const { query } = require('../db');

async function saveBriefing({ kind = 'daily', content, periodStart = null, periodEnd = null }) {
  const { rows } = await query(
    `INSERT INTO briefings (kind, content, period_start, period_end)
     VALUES ($1, $2, $3, $4) RETURNING id, generated_at`,
    [kind, content, periodStart, periodEnd]
  );
  return rows[0] ?? null;
}

async function latestBriefing(kind = 'weekly') {
  const { rows } = await query(
    `SELECT * FROM briefings WHERE kind = $1 ORDER BY generated_at DESC LIMIT 1`,
    [kind]
  );
  return rows[0] ?? null;
}

async function listBriefings({ kind = 'weekly', limit = 4 } = {}) {
  const { rows } = await query(
    `SELECT id, kind, generated_at, period_start, period_end, content FROM briefings
     WHERE kind = $1 ORDER BY generated_at DESC LIMIT $2`,
    [kind, limit]
  );
  return rows;
}

/**
 * The last `days` distinct CALENDAR days' chief-of-staff briefs, most recent
 * first, excluding today. Multiple manual rebuilds in one day each insert their
 * own row (no upsert), so this dedupes to the LATEST build per local day — the
 * version the user actually saw most. Used to give the brief-writer concrete
 * "here's what you said the last few mornings" grounding so it can recognize
 * when it's about to repeat itself instead of re-explaining a stale story fresh
 * every day.
 */
async function recentDailyBriefOpeners(days = 3) {
  const rows = await listBriefings({ kind: 'daily', limit: 40 });
  const tz = process.env.TZ || 'America/New_York';
  const localDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
  const todayLocal = localDay(new Date());
  const byDay = new Map(); // rows are DESC by generated_at, so first hit per day = that day's LAST build
  for (const r of rows) {
    const day = localDay(r.generated_at);
    if (day === todayLocal || byDay.has(day)) continue;
    const cb = r.content?.chiefBrief;
    if (cb) byDay.set(day, { day, ...cb });
  }
  return [...byDay.values()].slice(0, days);
}

module.exports = { saveBriefing, latestBriefing, listBriefings, recentDailyBriefOpeners };
