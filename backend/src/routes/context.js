// Nightly context tags router (Magnesium, Alcohol, …): stored as daily 0/1
// metrics under the `context` domain so the habit-split engine correlates
// them against HRV / sleep — our own version of Eight Sleep's tag insights,
// but cross-domain. Anchored at noon-UTC of the wake date (today), to line
// up with the wake-dated sleep metrics. Tenth router extraction out of
// server.js's monolith (see the engineering review's #1+#6 recommendation)
// — a straight move, verified line-by-line against the original before
// removing it from server.js.
const express = require('express');
const db = require('../db');
const metricsStore = require('../store/metrics');
const sourcesStore = require('../store/sources');
const { CONTEXT_TAGS, TAG_KEYS } = require('../intelligence/context-tags');
const { asyncHandler } = require('../middleware/asyncHandler');

function createContextRouter() {
  const router = express.Router();

  router.get('/context/tags', (req, res) => {
    res.json({ tags: CONTEXT_TAGS });
  });

  router.get('/context/today', asyncHandler(async (req, res) => {
    const tz = process.env.TZ || 'America/New_York';
    const { rows } = await db.query(
      `SELECT metric, value FROM metrics
        WHERE domain = 'context'
          AND (ts AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
      [tz]
    );
    const active = {};
    let submitted = false;
    for (const r of rows) {
      if (r.metric === '_submitted') { submitted = Number(r.value) >= 0.5; continue; }
      if (Number(r.value) >= 0.5) active[r.metric] = true;
    }
    // `submitted` lets the card hide itself for the rest of the day once dismissed.
    res.json({ logged: rows.length > 0, submitted, active });
  }));

  // Log tonight's/last-night's context. Records EVERY catalog tag as 0/1 for the day
  // so untagged tags are explicit "off" days for the correlation (not missing).
  router.post('/context', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const active = body.active && typeof body.active === 'object'
      ? new Set(Object.keys(body.active).filter((k) => body.active[k]))
      : new Set(Array.isArray(body.tags) ? body.tags : []);
    const tz = process.env.TZ || 'America/New_York';
    const dateStr = body.date || new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const ts = new Date(`${dateStr}T12:00:00Z`);
    await sourcesStore.registerSource({ id: 'self_report', domain: 'health', displayName: 'Self-reported' }).catch(() => {});
    const metrics = TAG_KEYS.map((k) => ({
      ts, domain: 'context', metric: k, value: active.has(k) ? 1 : 0, unit: 'bool', source: 'self_report',
    }));
    // A `submitted` marker (not a tracked tag, so it never enters correlations) so
    // the card can hide for the rest of the day once the user taps Submit.
    if (body.submitted) {
      metrics.push({ ts, domain: 'context', metric: '_submitted', value: 1, unit: 'bool', source: 'self_report' });
    }
    const written = await metricsStore.insertMetrics(metrics);
    res.json({ ok: true, date: dateStr, active: [...active], submitted: !!body.submitted, written });
  }));

  // Context per day over a window, keyed by date (YYYY-MM-DD). Lets a chart
  // tooltip answer "why did HRV plunge here?" by joining the tapped point's date to
  // (a) the nightly tags toggled that night (magnesium, alcohol, …) and (b) any
  // free-text context you wrote — chief-of-staff briefing answers, travel/illness
  // notes, etc. (annotations), attached to every day they span.
  router.get('/context/history', asyncHandler(async (req, res) => {
    const numDays = Math.max(1, Math.min(Number(req.query.days) || 60, 400));
    const meta = Object.fromEntries(CONTEXT_TAGS.map((t) => [t.key, t]));
    const tz = process.env.TZ || 'America/New_York';
    const window = String(numDays);

    const tagRowsP = db.query(
      `SELECT to_char((ts AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day, metric
         FROM metrics
        WHERE domain = 'context' AND value >= 0.5
          AND ts >= now() - ($2 || ' days')::interval`,
      [tz, window]
    );
    // Each annotation contributes its text to every calendar day it covers
    // (start→end), so a multi-day "Travel" note shows on every point it spans.
    const noteRowsP = db.query(
      `SELECT to_char(gd, 'YYYY-MM-DD') AS day, a.category AS category, a.label AS label
         FROM annotations a,
         LATERAL generate_series(
           GREATEST((a.start_ts AT TIME ZONE $1)::date::timestamp,
                    (now() AT TIME ZONE $1)::date - ($2 || ' days')::interval),
           LEAST((COALESCE(a.end_ts, a.start_ts) AT TIME ZONE $1)::date::timestamp,
                 (now() AT TIME ZONE $1)::date::timestamp),
           interval '1 day'
         ) AS gd
        WHERE COALESCE(a.end_ts, a.start_ts) >= now() - ($2 || ' days')::interval
          AND a.start_ts <= now()
          AND a.label IS NOT NULL
          -- Exclude financial/spending context — health charts shouldn't surface
          -- money notes. Catches both the tagged category (answers to spending
          -- prompts → 'spending note') and free-text notes that read as financial
          -- (e.g. "Vacation car rental") which land in the generic brief_context.
          AND a.category NOT ILIKE '%spend%'
          AND a.category NOT ILIKE '%financ%'
          AND a.label !~* '(\y(spent|spend|spending|bill|bills|rent|rental|invoice|purchase|bought|payment|paid|expense|expenses|budget|refund|deposit|salary|paycheck|mortgage|loan|vacation|flight|hotel|dollars?|cost|costs)\y|\$)'`,
      [tz, window]
    );
    const [{ rows: tagRows }, { rows: noteRows }] = await Promise.all([tagRowsP, noteRowsP]);

    const history = {};
    for (const r of tagRows) {
      const m = meta[r.metric]; // skips `_submitted` and any retired tag
      if (!m) continue;
      (history[r.day] ||= []).push({ key: m.key, label: m.label, emoji: m.emoji });
    }
    const notes = {};
    for (const r of noteRows) {
      const text = String(r.label || '').trim().slice(0, 140);
      if (!text) continue;
      const arr = (notes[r.day] ||= []);
      if (arr.length < 4 && !arr.some((x) => x.text === text)) arr.push({ text, category: r.category });
    }
    res.json({ history, notes });
  }));

  return router;
}

module.exports = { createContextRouter };
