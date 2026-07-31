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
const { recordUserContext } = require('../intelligence/context-input');

function createAnnotationsRouter() {
  const router = express.Router();

  router.post('/annotations', asyncHandler(async (req, res) => {
    const { startTs, endTs, category, label, note } = req.body || {};
    if (!requireFields(req.body, ['startTs', 'category', 'label'], res)) return;
    // A manual annotation is user context, not a second raw-only memory path.
    // Persist its audit row and compiled assertion(s) through the same shared
    // transaction Ask, voice, and check-ins use; a provider outage records a
    // durable retry job rather than silently losing structured meaning.
    const written = await recordUserContext({
      rawText: String(label).trim(), source: 'manual_annotation',
      writeInTransaction: (client, db) => annotationsStore.createAnnotation({ startTs, endTs, category, label, note }, db),
      getSourceAnnotationId: (annotation) => annotation?.id ?? null,
    });
    res.json({ id: written?.id ?? null });
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
    const outcome = await withTransaction(async (client) => {
      const db = (text, params) => client.query(text, params);
      const retiredAnnotation = await annotationsStore.retireAnnotation(id, 'deleted by user', db);
      if (!retiredAnnotation) return { retiredAnnotation: false, retiredAssertions: 0 };
      const retiredAssertions = await contextAssertionsStore.retireBySourceAnnotation(id, 'source annotation deleted by user', db);
      await require('../store/contextCompilationJobs').cancelForSourceAnnotation(id, db);
      return { retiredAnnotation, retiredAssertions };
    });
    if (outcome.retiredAnnotation) await require('../brain/invalidation').bumpDurable('annotation_retirement');
    if (outcome.retiredAssertions) await require('../brain/invalidation').bumpDurable('context_assertion_change');
    res.json({ ok: true });
  }));

  // Edits keep the annotation's stable ID, but they retire every assertion
  // compiled from its previous text and recompile the replacement atomically.
  // Without this, the UI showed the correction while Ask/briefing still read
  // the old assertion — two authorities for the same user statement.
  router.patch('/annotations/:id', asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== 'string' || id.length < 8) return res.status(400).json({ error: 'invalid id' });
    const { label, category } = req.body || {};
    if (label != null && !label.trim()) return res.status(400).json({ error: 'label cannot be blank' });
    if (label == null && category == null) return res.status(400).json({ error: 'label or category required' });
    const existing = await annotationsStore.getActiveById(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const nextLabel = label == null ? existing.label : label;
    const updated = await recordUserContext({
      rawText: String(nextLabel).trim(), source: 'manual_annotation_correction',
      contextChangedInTransaction: true,
      writeInTransaction: async (client, db) => {
        const changed = await annotationsStore.updateAnnotation(id, { label, category }, db);
        if (!changed) throw new Error('annotation update lost its active row');
        await contextAssertionsStore.retireBySourceAnnotation(id, 'source annotation corrected by user', db);
        await require('../store/contextCompilationJobs').cancelForSourceAnnotation(id, db);
        return { id };
      },
      getSourceAnnotationId: (annotation) => annotation?.id ?? null,
    });
    if (!updated) return res.status(400).json({ error: 'nothing to update' });
    res.json({ ok: true });
  }));

  // Pre-brief context answers — user responds to a signal question; store as
  // annotation so it flows into annotationsContext on the next briefing build.
  router.post('/briefing/context', asyncHandler(async (req, res) => {
    const { question, answer, signalKey, fingerprint, questionId } = req.body || {};
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

    // Canonical subject provenance for a Chief Brief openQuestion (see
    // store/openQuestionInstances.js + intelligence/open-question-policy.js's
    // bindOpenQuestionInstance): the SOLE authority for what this question's
    // subject is — never reconstructed from the answer text, and never
    // trusted from any client-supplied subjectLocalDate/blocks field, which
    // remain valid ONLY for the pre-brief-signal calendar_load path below
    // (a different, already-trusted mechanism — see pre-brief-signals.js's
    // blockRefsFor, computed and handed to the client at signal-generation
    // time, not user-suppliable free text). Absent `questionId` (an older
    // client, or a generic non-calendar question) degrades to the exact
    // pre-this-fix behavior — nothing below changes for it.
    let questionInstance = null;
    if (isOpenQuestionAnswer && typeof questionId === 'string' && questionId.trim()) {
      const openQuestionInstancesStore = require('../store/openQuestionInstances');
      questionInstance = await openQuestionInstancesStore.getById(questionId.trim()).catch((e) => {
        console.error('[briefing/context] openQuestionInstance lookup failed:', e.message);
        return null;
      });
    }
    // Idempotent short-circuit: already answered (a client retry after a
    // slow-but-successful first attempt, or a double-tap) — redoing the
    // compile/persist could double-classify or double-count in the ledger.
    if (questionInstance?.answeredAt) {
      return res.json({ ok: true, id: null, alreadyAnswered: true });
    }
    // Several comparably-sized candidate blocks, no safe dominant one (see
    // calendar-block-identity.js's pickBlockBinding) — resolved at
    // question-generation time, not guessable now. Fail closed with a
    // distinct, actionable code BEFORE any compile/persist: nothing is
    // written, the question stays open and answerable, and the client can
    // tell this apart from a transient compiler failure. A real
    // clarification UI (asking the user WHICH block) is a client follow-up
    // out of scope here — the contract this closes is "never a false
    // success," not "never ask twice."
    if (questionInstance?.subjectType === 'calendar_load' && questionInstance.subjectAmbiguous) {
      return res.status(409).json({
        error: 'Multiple meetings could match that answer — NormOS needs a more specific reply (which one, or its time) to apply the correction.',
        code: 'calendar_subject_ambiguous',
      });
    }
    // Question-time provenance ("give every question a canonical subject"):
    // the client echoes back the EXACT local date/block(s) a structured
    // calendar-load question described — computed server-side when the
    // question was generated (see intelligence/pre-brief-signals.js's
    // `blocks` field for the pre-brief-signal path, or `questionInstance`
    // above for a Chief Brief openQuestion), never reconstructed here from
    // the answer's own (often date/block-free) wording. `subjectLocalDate`
    // defaults to the date embedded in a `calendar_load:<date>` signalKey
    // but can also be sent explicitly for the pre-brief-signal path. Both
    // are untrusted-but-bounded client input: capped in size and only ever
    // used to bind a classification assertion's date/target — never blindly
    // trusted as a fact about the calendar itself.
    const instanceIsCalendarLoad = questionInstance?.subjectType === 'calendar_load';
    const subjectLocalDate = instanceIsCalendarLoad
      ? questionInstance.subjectLocalDate
      : (typeof req.body?.subjectLocalDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.subjectLocalDate))
        ? req.body.subjectLocalDate
        : (calendarLoadMatch ? calendarLoadMatch[1] : null);
    const subjectBlocks = instanceIsCalendarLoad
      ? questionInstance.subjectBlockIds.map((id) => ({ id }))
      : (Array.isArray(req.body?.blocks) ? req.body.blocks.slice(0, 20) : null);
    // An "identity-bearing" question is one where the answer is expected to
    // durably change a specific calendar-load subject — the ONLY case where
    // "answered but not structurally understood" is worse than not
    // answering at all (see below, after compilation runs).
    const isIdentityBearingQuestion = Boolean(calendarLoadMatch) || Boolean(subjectLocalDate) || instanceIsCalendarLoad;
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
      subjectLocalDate, subjectBlocks,
    });
    if (compiled.failed) {
      console.error(`[briefing/context] context compilation failed (${compiled.failureType})${isIdentityBearingQuestion ? '' : ' — annotation still saved, no structured assertions this time.'}`);
    }
    // For an identity-bearing question (a calendar-load subject the client
    // expects to be durably reclassified), "answered but not understood"
    // must never read as success — a generic annotation with no calendar
    // assertion behind it would silently let the SAME stale meeting-hours
    // number keep computing on every later build, which is indistinguishable
    // from the answer having been lost. Nothing has been persisted yet (this
    // check runs BEFORE the transaction below opens), so the client can
    // safely retry the whole request. Every OTHER kind of answer (a plain
    // "add context" note, an ordinary chief-brief openQuestion reply)
    // preserves the original behavior exactly — the raw note is never lost
    // just because structured extraction didn't fire.
    if (isIdentityBearingQuestion) {
      // When candidate blocks were actually supplied (both the pre-brief-
      // signal path's echoed `blocks` and a Chief Brief calendar-load
      // instance's resolved subjectBlockIds always supply at least one —
      // see open-question-subject.js), success requires an EXACT
      // subject-bound `classifies` relation: a calendar-domain
      // classification assertion whose classifiedBlockId was actually set
      // (compileUserContext/pickBlockBinding only sets it when unambiguous —
      // see context-compiler.js). Any calendar-domain assertion with NO
      // block binding is exactly the "answered but not understood" case
      // this gate exists to catch, even though `compiled.failed` is false.
      // A day-only subject with no candidate blocks at all (subjectBlocks
      // null/empty) keeps the original, looser "some calendar assertion"
      // bar — read-time fuzzy matching (matchCalendarClassifications
      // priorities 2/3) is still the intended path for that case.
      const hasBlocks = Array.isArray(subjectBlocks) && subjectBlocks.length > 0;
      const boundOk = !compiled.failed && compiled.assertions.some((a) => {
        if (!(a.domains || []).includes('calendar')) return false;
        return hasBlocks ? Boolean(a.classifiedBlockId) : true;
      });
      if (!boundOk) {
        const wasAmbiguous = hasBlocks && !compiled.failed && compiled.assertions.some((a) => a.subjectAmbiguous);
        if (wasAmbiguous) {
          console.error('[briefing/context] identity-bearing calendar-load answer resolved to multiple candidate blocks with no dominant one — refusing to report success; needs a targeted clarification.');
          return res.status(409).json({
            error: 'Multiple meetings could match that answer — NormOS needs a more specific reply (which one, or its time) to apply the correction.',
            code: 'calendar_subject_ambiguous',
          });
        }
        console.error(`[briefing/context] identity-bearing calendar-load answer was not structurally understood (${compiled.failed ? compiled.failureType : 'no block-bound calendar classification produced'}) — refusing to report success; the client should retry.`);
        return res.status(503).json({
          error: 'NormOS could not confirm it understood that answer — please try again.',
          code: 'context_compilation_failed',
        });
      }
    }

    let id, eventKind, retiredAnnotationId, retiredAssertionCount = 0;
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
      if (result.retiredAnnotationId) {
        // A retraction that retires its raw annotation must retire the
        // compiled assertion(s) in this same transaction. Otherwise
        // ResolvedContext could continue to surface the thing the user just
        // explicitly withdrew.
        retiredAssertionCount = await contextAssertionsStore.retireBySourceAnnotation(
          result.retiredAnnotationId,
          'source annotation retracted by user',
          db
        );
        await require('../store/contextCompilationJobs').cancelForSourceAnnotation(result.retiredAnnotationId, db);
      }
      if (compiled.assertions.length) {
        await persistCompiledContext(compiled, { sourceAnnotationId: result.id, db });
      } else if (compiled.failed) {
        // Generic brief-context answers must not become a second permanent
        // raw-only path when the compiler provider is temporarily down. The
        // identity-bearing path returned above before opening this
        // transaction, so this is only the safe fail-open case where saving
        // the user's own words is still useful.
        await require('../store/contextCompilationJobs').enqueue({
          sourceAnnotationId: result.id,
          rawText: answer.trim(),
          source: 'briefing_context',
          question: question || null,
          timezone: tz,
          recordedAt: nowTs,
        }, db);
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
      // Stamp the canonical instance answered atomically with everything
      // else above — a partial failure must never leave a calendar-load
      // instance durably answered without its classification (or vice
      // versa). Only reached once the identity-bearing gate above already
      // confirmed the exact subject-bound write succeeded (for a
      // calendar_load instance); a generic (subjectType: null) instance has
      // no such requirement and is stamped unconditionally, same as before.
      if (questionInstance) {
        await require('../store/openQuestionInstances').markAnswered(questionInstance.id, db);
      }
      return result;
    }));
    // Invalidation happens STRICTLY AFTER commit, and only because we got
    // here at all (a rejected transaction throws out of the `await` above,
    // so this line is unreached on rollback — never invalidates toward
    // state that was never actually committed). bumpDurable (not bump) is
    // used deliberately: it awaits the durable cross-instance write-through
    // before this handler responds, so a request that immediately hits a
    // DIFFERENT instance right after this one can't observe a version bump
    // for context that instance's own connection hasn't seen committed yet
    // — the exact race a prior version of this code had by calling
    // invalidation.bump() from INSIDE persistCompiledContext, i.e. inside
    // the still-open transaction, before COMMIT (see that function's doc
    // comment in intelligence/context-compiler.js).
    // The annotation write itself (and any retraction-triggered retirement of
    // a prior one, per createAnnotation's own logic) needs the SAME
    // after-commit treatment now that store/annotations.js no longer
    // invalidates itself — this is the one new invalidation this handler
    // needs for the write above.
    if (id) {
      await require('../brain/invalidation').bumpDurable('annotation_retirement');
    }
    if (compiled.assertions.length || retiredAssertionCount) {
      await require('../brain/invalidation').bumpDurable('context_assertion_change');
    }
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
