// Strength progression — turns logged sets into per-exercise trends.
//
// Estimated 1RM uses the Epley formula (w × (1 + reps/30), best set per session),
// which is rep-range agnostic so 3×8@135 and 3×10@135 sit on one curve. Volume is
// total work (Σ reps × weight). Bodyweight-only lifts fall back to total reps.
const { query } = require('../db');

const epley = (w, r) => (w > 0 && r > 0 ? w * (1 + r / 30) : 0);

/**
 * Pure transform. rows: [{ exercise, day, sets:[{reps,weight_lbs}] }] sorted by
 * (exercise, day ASC). Returns one entry per exercise with ≥2 sessions.
 */
function computeProgression(rows, { limit = 10 } = {}) {
  const byEx = {};
  for (const row of rows) {
    let e1rm = 0, volume = 0, topW = 0, topR = 0, reps = 0;
    for (const s of row.sets || []) {
      const w = Number(s.weight_lbs) || 0, r = Number(s.reps) || 0;
      volume += w * r; reps += r;
      const e = epley(w, r);
      if (e > e1rm) e1rm = e;
      if (w > topW) { topW = w; topR = r; }
    }
    (byEx[row.exercise] ||= []).push({
      date: row.day, e1rm: Math.round(e1rm), volume: Math.round(volume), reps, topWeight: topW, topReps: topR,
    });
  }

  const out = [];
  for (const [name, allSessions] of Object.entries(byEx)) {
    const sessions = allSessions.slice(-limit);
    if (sessions.length < 2) continue;
    const weighted = sessions.some((s) => s.e1rm > 0);
    const metric = weighted ? 'e1rm' : 'reps';
    const unit = weighted ? 'lb' : 'reps';
    const pts = sessions.filter((s) => s[metric] > 0);
    let delta = null;
    if (pts.length >= 2) {
      const first = pts[0][metric], last = pts[pts.length - 1][metric];
      delta = { first, last, pct: first ? Math.round(((last - first) / first) * 100) : null };
    }
    const best = sessions.reduce((b, s) => (s[metric] > (b?.[metric] ?? -1) ? s : b), null);
    // New PR = the latest session strictly beats every earlier one in the window.
    const lastVal = sessions[sessions.length - 1][metric];
    const newPR = lastVal > 0 && sessions.slice(0, -1).every((s) => lastVal > s[metric]);
    out.push({ exercise: name, metric, unit, n: sessions.length, sessions, delta, best, newPR });
  }
  return out;
}

/** Progression for a specific set of exercises (the workout view). */
async function fetchProgression(names, limit = 10) {
  if (!names || !names.length) return [];
  const { rows } = await query(
    `SELECT exercise, to_char(log_date, 'YYYY-MM-DD') AS day,
            json_agg(json_build_object('reps', reps, 'weight_lbs', weight_lbs) ORDER BY set_number) AS sets
       FROM workout_logs WHERE exercise = ANY($1)
      GROUP BY exercise, log_date ORDER BY exercise, log_date ASC`,
    [names]
  );
  return computeProgression(rows, { limit });
}

/**
 * One-line brief nugget: the biggest estimated-1RM gainer across all exercises
 * logged in the last `days`. Returns null if nothing has ≥minSessions or no gains.
 */
async function topProgressionNote({ days = 45, minSessions = 3 } = {}) {
  const { rows } = await query(
    `SELECT exercise, to_char(log_date, 'YYYY-MM-DD') AS day,
            json_agg(json_build_object('reps', reps, 'weight_lbs', weight_lbs) ORDER BY set_number) AS sets
       FROM workout_logs
      WHERE log_date >= now() - ($1 || ' days')::interval
      GROUP BY exercise, log_date ORDER BY exercise, log_date ASC`,
    [String(days)]
  );
  const prog = computeProgression(rows, { limit: 12 })
    .filter((p) => p.metric === 'e1rm' && p.n >= minSessions && p.delta && p.delta.pct != null && p.delta.pct > 0);
  if (!prog.length) return null;
  prog.sort((a, b) => (b.delta.pct - a.delta.pct) || (b.n - a.n));
  const t = prog[0];
  return `Strength: ${t.exercise} estimated 1RM up ${t.delta.pct}% over ${t.n} sessions (${t.delta.first}→${t.delta.last} lb)${t.newPR ? ' — new PR last session' : ''}.`;
}

module.exports = { computeProgression, fetchProgression, topProgressionNote, epley };
