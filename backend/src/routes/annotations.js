// Life-context annotations router: CRUD for the annotations that let the
// intelligence layer (and the user) explain anomalies instead of being
// misled — plus the pre-brief context-answer endpoint, which stores its
// answers as annotations too and is grouped here for that reason (matches
// the original "// --- Life context (annotations) ---" section in server.js).
//
// Second router extraction out of server.js's monolith (see the engineering
// review's #1+#6 recommendation) — a straight move, verified line-by-line
// against the original before removing it from server.js.
const express = require('express');
const annotationsStore = require('../store/annotations');
const briefingsStore = require('../store/briefings');
const dayJournalStore = require('../store/dayJournal');
const { naiveToUtcIso, localDayBoundsUtc } = require('../util/date');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireFields } = require('../middleware/validate');

function createAnnotationsRouter() {
  const router = express.Router();

  router.post('/annotations', asyncHandler(async (req, res) => {
    const { startTs, endTs, category, label, note } = req.body || {};
    if (!requireFields(req.body, ['startTs', 'category', 'label'], res)) return;
    const id = await annotationsStore.createAnnotation({ startTs, endTs, category, label, note });
    res.json({ id });
  }));

  router.get('/annotations', asyncHandler(async (req, res) => {
    let { from, to } = req.query;
    // Use the client's timezone (X-Time-Zone header) so date boundaries are correct
    // when the user is travelling. Falls back to server TZ (America/New_York).
    const tz = req.headers['x-time-zone'] || process.env.TZ || 'America/New_York';
    res.json({ annotations: await annotationsStore.listAnnotations({ from: naiveToUtcIso(from, tz), to: naiveToUtcIso(to, tz) }) });
  }));

  // Returns annotations that are CURRENTLY ACTIVE — same overlapping() query the
  // briefing uses. Needed because multi-day events (travel) have start_ts in the
  // past, so they're invisible to the ?from=today list query in the ContextCard.
  router.get('/annotations/active', asyncHandler(async (req, res) => {
    const { start: startOfToday } = localDayBoundsUtc(process.env.TZ || 'America/New_York');
    const active = await annotationsStore.overlapping(startOfToday, new Date());
    res.json({ annotations: active });
  }));

  router.delete('/annotations/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== 'string' || id.length < 8) return res.status(400).json({ error: 'invalid id' });
    const { query } = require('../db');
    await query('DELETE FROM annotations WHERE id = $1', [id]);
    res.json({ ok: true });
  }));

  // Edits the SAME row in place (not a new insert) — every downstream reader
  // (analyze.js's health-anomaly "Context: ..." labeling, the briefing's
  // annotationsContext, wealth-insights' spend-context filter) queries the
  // annotations table live on each build, so a correction here is picked up by
  // the very next read with no separate propagation step needed.
  router.patch('/annotations/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== 'string' || id.length < 8) return res.status(400).json({ error: 'invalid id' });
    const { label, category } = req.body || {};
    if (label != null && !label.trim()) return res.status(400).json({ error: 'label cannot be blank' });
    if (label == null && category == null) return res.status(400).json({ error: 'label or category required' });
    const updated = await annotationsStore.updateAnnotation(id, { label, category });
    if (!updated) return res.status(400).json({ error: 'nothing to update' });
    res.json({ ok: true });
  }));

  // Pre-brief context answers — user responds to a signal question; store as
  // annotation so it flows into annotationsContext on the next briefing build.
  router.post('/briefing/context', asyncHandler(async (req, res) => {
    const { question, answer, signalKey } = req.body || {};
    if (!answer || typeof answer !== 'string' || !answer.trim()) {
      return res.status(400).json({ error: 'answer required' });
    }
    // Tag spending-related answers so they're excluded from health/recovery anomaly
    // context (a "$665 on vacation" answer must never explain a low-HRV deviation).
    // The 'spend' substring is what the anomaly filter in analyze.js keys off.
    // Scan the prompt AND the free-text answer — notes typed into the generic
    // "add context" box carry no signalKey, so "Vacation car rental" must be
    // caught by its own wording.
    const FINANCIAL_RE = /\b(spend|spent|spending|financ|wealth|budget|money|bill|bills|rent|rental|invoice|purchase|bought|payment|paid|expense|refund|salary|paycheck|mortgage|loan|vacation|flight|hotel|dollar|cost)\b|\$/i;
    const isSpending = FINANCIAL_RE.test(`${signalKey || ''} ${question || ''} ${answer}`);
    // An answer to a question framed around "last night"/"yesterday" is
    // explaining something already PAST (e.g. "No Eight Sleep reading last
    // night — device issue, or skipped it?" -> "Didn't sleep home") — not a
    // forward-looking note. createAnnotation's default window (start_ts=now,
    // end_ts=end of TOMORROW) is built for the opposite case (a note entered
    // now about today/tomorrow), so left at "now" this reads as active
    // THROUGH tomorrow — exactly how a real answer about last night ended up
    // being cited as a caveat on TOMORROW's forecast instead of explaining
    // today's already-collected data. Backdate to yesterday so the default
    // window (yesterday -> end of today) covers what it actually explains.
    const PAST_REFERRING_RE = /\blast night\b|\byesterday\b|\bovernight\b/i;
    const startTs = PAST_REFERRING_RE.test(question || '')
      ? new Date(Date.now() - 24 * 60 * 60 * 1000)
      : new Date();
    const id = await annotationsStore.createAnnotation({
      startTs: startTs.toISOString(),
      category: isSpending ? 'spending note' : 'brief_context',
      label: answer.trim().slice(0, 500),
      note: question ? `Q: ${question.slice(0, 300)}` : (signalKey ?? null),
    });
    // Text parity with voice: free-form context typed into the "add context" box
    // is the SAME signal as talking about your day, so also capture it in the day
    // journal (→ Ask brain, evening brief, self-model). Skip the openQuestion
    // path (short Q&A answers) and trivially short notes to keep the journal clean.
    const isDayContext = (!signalKey || signalKey === 'manual_context') && answer.trim().length >= 6;
    if (isDayContext) {
      const tz = process.env.TZ || 'America/New_York';
      // A past-referring question ("last night", "yesterday") is asking about the
      // previous day — store the journal entry for that day so it shows up as
      // context for the right date (not today's evening brief or tomorrow's morning).
      const entryDate = PAST_REFERRING_RE.test(question || '')
        ? new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: tz })
        : new Date().toLocaleDateString('en-CA', { timeZone: tz });
      dayJournalStore.create({ text: answer.trim(), entryDate, source: 'brief' })
        .catch((e) => console.error('[day journal] capture from brief context failed:', e.message));
    }
    // Answering the chief brief's one question retires it from today's CACHED
    // builds too — the question lives in stored briefing JSON, so component
    // state alone can't dismiss it: a tab switch remounts the card from cache
    // and the already-answered question pops back up. Best-effort — the
    // annotation above (the actual answer) is the critical write.
    if (signalKey === 'brief_open_question') {
      briefingsStore.blankTodaysOpenQuestion()
        .then((n) => { if (n > 0) console.log(`[briefing/context] retired answered openQuestion from ${n} cached build(s)`); })
        .catch((e) => console.error('[briefing/context] openQuestion retire failed:', e.message));
    }
    res.json({ ok: true, id });
  }));

  return router;
}

module.exports = { createAnnotationsRouter };
