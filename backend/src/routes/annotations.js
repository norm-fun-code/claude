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
const openQuestionsStore = require('../store/openQuestions');
const { naiveToUtcIso, localDayBoundsUtc, localDateStr } = require('../util/date');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireFields } = require('../middleware/validate');
const { EVENT_KIND, describesCompletedNight } = require('../intelligence/context-semantics');
const { openQuestionFingerprint, openQuestionTopicKey } = require('../intelligence/open-question-policy');
const contextAssertionsStore = require('../store/contextAssertions');
const { compileUserContext, persistCompiledContext } = require('../intelligence/context-compiler');
const { withTransaction } = require('../db');

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
    // The chief brief's "one open question" — see
    // intelligence/open-question-policy.js for the full rationale. Answering
    // it must durably retire it (this ledger row + the cached-brief blank
    // below) atomically with the explanatory annotation, so a partial
    // failure can never leave the question durably suppressed with its
    // answer lost, or vice versa.
    const isOpenQuestionAnswer = signalKey === 'brief_open_question' && !!String(question || '').trim();
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
    // Centralized in context-semantics.js's describesCompletedNight — it
    // binds on the SIGNAL itself (recovery_low's answer is inherently about
    // last night, wording or not: "I had a drink and late meal" carries no
    // date phrase at all) as well as on expanded wording ("last evening",
    // "the night before", "previous night", not just the original narrow
    // "last night"/"yesterday"/"overnight").
    const isPastReferring = describesCompletedNight({ signalKey, question, answer });
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
    const annotationPayload = {
      startTs: startTs.toISOString(),
      endTs: effectiveEndTs ? effectiveEndTs.toISOString() : undefined,
      category: isSpending ? 'spending note' : 'brief_context',
      label: answer.trim().slice(0, 500),
      note: question ? `Q: ${question.slice(0, 300)}` : (signalKey ?? null),
    };
    // Context Understanding Layer: compile this answer into structured
    // ContextAssertions/ContextRelations BEFORE opening the transaction (the
    // LLM call must not hold a DB transaction open — see
    // intelligence/context-compiler.js). recentActiveAssertions is a short
    // lookback (7 days, this endpoint's own answers/notes only need recent
    // history to match a correction against) so a temporal/classification/
    // completion correction can find what it's superseding. A compiler
    // failure (refusal/timeout/malformed response) degrades to zero
    // assertions — compileUserContext never throws — so it can never block
    // the underlying annotation write below.
    const compiled = await compileUserContext({
      rawText: answer.trim(), source: 'briefing_context', question: question || null, tz, now: nowTs,
      recentActiveAssertions: await contextAssertionsStore.getActive({ recordedFrom: new Date(nowTs.getTime() - 7 * 24 * 60 * 60 * 1000) }).catch(() => []),
    });
    if (compiled.failed) {
      console.error(`[briefing/context] context compilation failed (${compiled.failureType}) — annotation still saved, no structured assertions this time.`);
    }

    let id, eventKind, retiredAnnotationId;
    // Atomic: any durable "answered, don't ask again" ledger row
    // (signal_answers for calendar_load — store/signalAnswers.js;
    // answered_open_questions for the chief brief's one question —
    // store/openQuestions.js), the annotation that explains WHY, and any
    // compiled ContextAssertions/ContextRelations must all commit or fail
    // together. For the open-question case, the cached-build retirement
    // (briefingsStore.blankTodaysOpenQuestion) is folded into the SAME
    // transaction too — previously it ran as a fire-and-forget call after
    // the response could already be in flight, so answering and immediately
    // triggering a rebuild could race the retirement write, and a failure
    // there left the ledger row answered but a stale cached build still
    // showing the question. Every store here accepts an injectable `db`
    // (see store/annotations.js, store/signalAnswers.js,
    // store/openQuestions.js, store/briefings.js, store/contextAssertions.js,
    // store/contextRelations.js) so one transaction client drives every
    // write — asyncHandler forwards a rejection (including a failed COMMIT)
    // to the error middleware with no swallowing, so the response can never
    // claim success unless EVERY write landed, and a failure leaves none of
    // them behind.
    ({ id, eventKind, retiredAnnotationId } = await withTransaction(async (client) => {
      const db = (text, params) => client.query(text, params);
      if (calendarLoadMatch) {
        await signalAnswersStore.recordAnswer({
          subjectKey: 'calendar_load', localDate: calendarLoadMatch[1], fingerprint, answer: answer.trim(),
        }, db);
      }
      const result = await annotationsStore.createAnnotation(annotationPayload, db);
      if (compiled.assertions.length) {
        await persistCompiledContext(compiled, { sourceAnnotationId: result.id, db });
      }
      if (isOpenQuestionAnswer) {
        await openQuestionsStore.recordAnswered({
          localDate: localDateStr(tz, nowTs),
          questionText: question,
          fingerprint: openQuestionFingerprint(question),
          topicKey: openQuestionTopicKey(question),
          answer: answer.trim(),
        }, db);
        const n = await briefingsStore.blankTodaysOpenQuestion(tz, db);
        if (n > 0) console.log(`[briefing/context] retired answered openQuestion from ${n} cached build(s)`);
      }
      return result;
    }));
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
    res.json({ ok: true, id });
  }));

  return router;
}

module.exports = { createAnnotationsRouter };
