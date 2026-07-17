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
const signalAnswersStore = require('../store/signalAnswers');
const { naiveToUtcIso, localDayBoundsUtc, localDateStr } = require('../util/date');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireFields } = require('../middleware/validate');
const { EVENT_KIND } = require('../intelligence/context-semantics');

function createAnnotationsRouter() {
  const router = express.Router();

  router.post('/annotations', asyncHandler(async (req, res) => {
    const { startTs, endTs, category, label, note } = req.body || {};
    if (!requireFields(req.body, ['startTs', 'category', 'label'], res)) return;
    const { id } = await annotationsStore.createAnnotation({ startTs, endTs, category, label, note });
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
    const { question, answer, signalKey, fingerprint } = req.body || {};
    if (!answer || typeof answer !== 'string' || !answer.trim()) {
      return res.status(400).json({ error: 'answer required' });
    }
    // Durable, server-side dedup for calendar_load signals (see
    // intelligence/pre-brief-signals.js and store/signalAnswers.js): a
    // signalKey of the form `calendar_load:<local-date>` is a STABLE subject
    // key shared by both "tomorrow's calendar is heavily blocked" (asked the
    // day before) and "you have N.Nh of meetings today" (asked same-day) —
    // recording the answer here is what lets either one suppress the other
    // on a later build, regardless of which build asked first. The mobile
    // client's AsyncStorage cache is only an optimistic UI layer in front of
    // this; a fresh install / second device / cache eviction must still not
    // re-ask a question already answered here.
    const CALENDAR_LOAD_KEY_RE = /^calendar_load:(\d{4}-\d{2}-\d{2})$/;
    const calendarLoadMatch = CALENDAR_LOAD_KEY_RE.exec(String(signalKey || ''));
    if (calendarLoadMatch) {
      signalAnswersStore
        .recordAnswer({ subjectKey: 'calendar_load', localDate: calendarLoadMatch[1], fingerprint, answer: answer.trim() })
        .catch((e) => console.error('[briefing/context] signal answer record failed:', e.message));
    }
    // Tag spending-related answers so they're excluded from health/recovery anomaly
    // context (a "$665 on vacation" answer must never explain a low-HRV deviation).
    // The 'spend' substring is what the anomaly filter in analyze.js keys off.
    // Scan the prompt AND the free-text answer — notes typed into the generic
    // "add context" box carry no signalKey, so "Vacation car rental" must be
    // caught by its own wording.
    const FINANCIAL_RE = /\b(spend|spent|spending|financ|wealth|budget|money|bill|bills|rent|rental|invoice|purchase|bought|payment|paid|expense|refund|salary|paycheck|mortgage|loan|vacation|flight|hotel|dollar|cost)\b|\$/i;
    const isSpending = FINANCIAL_RE.test(`${signalKey || ''} ${question || ''} ${answer}`);
    // An answer explaining something already PAST ("No Eight Sleep reading
    // last night — device issue, or skipped it?" -> "Didn't sleep home", or
    // a question with no such phrasing answered "overnight guest") is not a
    // forward-looking note — bind its EFFECTIVE window to the actual night it
    // describes, not to createAnnotation's default (start_ts=now, end_ts=end
    // of TOMORROW), which reads a last-night answer as active through
    // tomorrow night too and lets it get cited as a caveat on TOMORROW's
    // forecast instead of explaining last night's already-collected data.
    // Scan question AND answer together (matches FINANCIAL_RE's approach
    // above) — a free-text answer to a question with no such phrasing still
    // needs to be recognized ("Woke up at 3am" answering a generic prompt).
    const PAST_REFERRING_RE = /\blast night\b|\byesterday\b|\bovernight\b/i;
    const isPastReferring = PAST_REFERRING_RE.test(`${question || ''} ${answer}`);
    // The user's timezone (matches GET /annotations above) — a night window
    // computed in the wrong tz can land on the wrong calendar date entirely.
    const tz = req.headers['x-time-zone'] || process.env.TZ || 'America/New_York';
    const nowTs = new Date();
    let startTs = nowTs;
    let effectiveEndTs; // undefined = let createAnnotation apply its normal default
    if (isPastReferring) {
      // Reuse the SAME previous-evening -> wake-window projection the health-
      // anomaly pipeline uses to decide what "last night" actually spans
      // (analyze.js's resolveNightWindow) — one canonical definition of "last
      // night," not a second, looser one reinvented here. `created_at` (set
      // by the DB default below) is untouched by any of this; only the
      // annotation's effective start_ts/end_ts move.
      const { resolveNightWindow } = require('../intelligence/analyze');
      const metricsStore = require('../store/metrics');
      const todayKey = localDateStr(tz, nowTs);
      let wakeTimeSeries = [];
      try {
        const from = new Date(nowTs.getTime() - 3 * 24 * 60 * 60 * 1000);
        wakeTimeSeries = await metricsStore.dailyAggregatePreferSource({
          domain: 'health', metric: 'wake_time', from, agg: 'avg', sources: ['eight_sleep'],
        });
      } catch { /* resolveNightWindow falls back to a default wake hour */ }
      const nightWindow = resolveNightWindow(todayKey, wakeTimeSeries, tz);
      startTs = nightWindow.start;
      effectiveEndTs = nightWindow.end;
    }
    const { id, eventKind, retiredAnnotationId } = await annotationsStore.createAnnotation({
      startTs: startTs.toISOString(),
      endTs: effectiveEndTs ? effectiveEndTs.toISOString() : undefined,
      category: isSpending ? 'spending note' : 'brief_context',
      label: answer.trim().slice(0, 500),
      note: question ? `Q: ${question.slice(0, 300)}` : (signalKey ?? null),
    });
    if (retiredAnnotationId) {
      console.log(`[briefing/context] retraction retired prior annotation ${retiredAnnotationId}`);
    }
    // Text parity with voice: free-form context typed into the "add context" box
    // is the SAME signal as talking about your day, so also capture it in the day
    // journal (→ Ask brain, evening brief, self-model). Skip the openQuestion
    // path (short Q&A answers), trivially short notes, and — critically — an
    // explicit RETRACTION ("please forget that context", "ignore that", "I
    // didn't end up going...") so a correction never gets journaled as if it
    // were ordinary life context and re-surfaces through the beliefs pipeline
    // or a future prompt. The annotation row above is still saved (audit), but
    // day_journal/beliefs never see it.
    const isDayContext = (!signalKey || signalKey === 'manual_context') && answer.trim().length >= 6
      && eventKind !== EVENT_KIND.RETRACTION;
    if (isDayContext) {
      // A past-referring answer ("last night", "yesterday") is describing the
      // previous evening — store the journal entry against THAT date (the
      // same effective start_ts computed above) so it shows up as context for
      // the right date, not today's evening brief or tomorrow's morning.
      const entryDate = isPastReferring ? localDateStr(tz, startTs) : localDateStr(tz, nowTs);
      // Awaited (not fire-and-forget): a caller reading dayJournalStore right
      // after this response resolves — the mobile app's own optimistic UI,
      // Ask, the evening brief — must see the entry. This used to be a bare
      // .catch() with no await, a latent race that got reliably exposed once
      // createAnnotation() above started doing more concurrent work per call
      // (the invalidation bus's durable version write-through) and lost the
      // race against res.json() below more often.
      try {
        await dayJournalStore.create({ text: answer.trim(), entryDate, source: 'brief' });
      } catch (e) { console.error('[day journal] capture from brief context failed:', e.message); }
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
