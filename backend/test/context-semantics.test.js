// Unit tests for the shared context/annotation-eligibility module — see the
// file header in src/intelligence/context-semantics.js for the bug this
// exists to fix (a user's retraction narrated as a possible cause of an
// elevated resting-HR anomaly).
const test = require('node:test');
const assert = require('node:assert/strict');
const cs = require('../src/intelligence/context-semantics');

// ── classifyEventKind ────────────────────────────────────────────────────

test('classifyEventKind: the exact screenshot sentence is a retraction', () => {
  const text = "I didnt end up going for drinks with friends tonight. Please forget that context.";
  assert.equal(cs.classifyEventKind(text), cs.EVENT_KIND.RETRACTION);
});

test('classifyEventKind: natural retraction/correction variants', () => {
  const variants = [
    'forget that',
    'please forget that context',
    'ignore that',
    'disregard that',
    'never mind',
    'nevermind',
    'that didnt happen',
    "that didn't happen",
    'actually no, that was wrong',
    'the plan was cancelled',
    'the plan was canceled',
    'that is no longer relevant',
    'not relevant anymore',
    'scratch that',
  ];
  for (const v of variants) {
    assert.equal(cs.classifyEventKind(v), cs.EVENT_KIND.RETRACTION, `"${v}" should classify as retraction`);
  }
});

test('classifyEventKind: apostrophe-free negation is still recognized', () => {
  assert.equal(cs.classifyEventKind('I didnt drink last night'), cs.EVENT_KIND.NEGATED);
  assert.equal(cs.classifyEventKind("I didn't drink last night"), cs.EVENT_KIND.NEGATED);
});

test('classifyEventKind: a plain negation is NEGATED, not RETRACTION', () => {
  assert.equal(cs.classifyEventKind('I did not drink last night'), cs.EVENT_KIND.NEGATED);
  assert.equal(cs.classifyEventKind("I didn't go out"), cs.EVENT_KIND.NEGATED);
});

test('classifyEventKind: a future plan is PLANNED', () => {
  assert.equal(cs.classifyEventKind('Drinks with friends tonight'), cs.EVENT_KIND.PLANNED);
  assert.equal(cs.classifyEventKind('Planning drinks tonight'), cs.EVENT_KIND.PLANNED);
  assert.equal(cs.classifyEventKind('Going to a work dinner tomorrow'), cs.EVENT_KIND.PLANNED);
});

test('classifyEventKind: a completed event is OCCURRED', () => {
  assert.equal(cs.classifyEventKind('Had 3 drinks last night'), cs.EVENT_KIND.OCCURRED);
  assert.equal(cs.classifyEventKind('Room was very hot last night'), cs.EVENT_KIND.OCCURRED);
});

test('classifyEventKind: multi-day illness/travel language is ONGOING', () => {
  assert.equal(cs.classifyEventKind('Still sick, day 3 of the flu'), cs.EVENT_KIND.ONGOING);
  assert.equal(cs.classifyEventKind('Been traveling for the past 4 days'), cs.EVENT_KIND.ONGOING);
  assert.equal(cs.classifyEventKind('Recovering from a cold'), cs.EVENT_KIND.ONGOING);
});

test('classifyEventKind: category hint pushes a plain statement to ONGOING only when nothing else overrides', () => {
  assert.equal(cs.classifyEventKind('Down with a cold', { category: 'illness' }), cs.EVENT_KIND.ONGOING);
  assert.equal(cs.classifyEventKind('Traveling for work', { category: 'travel' }), cs.EVENT_KIND.ONGOING);
  // A retraction/negation/future cue still wins even with the category hint.
  assert.equal(cs.classifyEventKind('Actually, forget that illness note', { category: 'illness' }), cs.EVENT_KIND.RETRACTION);
  assert.equal(cs.classifyEventKind('Traveling next week', { category: 'travel' }), cs.EVENT_KIND.PLANNED);
});

test('classifyEventKind: empty/missing text defaults to OCCURRED (never crashes)', () => {
  assert.equal(cs.classifyEventKind(''), cs.EVENT_KIND.OCCURRED);
  assert.equal(cs.classifyEventKind(null), cs.EVENT_KIND.OCCURRED);
  assert.equal(cs.classifyEventKind(undefined), cs.EVENT_KIND.OCCURRED);
});

test('isRetraction convenience wrapper matches classifyEventKind', () => {
  assert.equal(cs.isRetraction('please forget that context'), true);
  assert.equal(cs.isRetraction('had 3 drinks last night'), false);
});

// ── isPlausibleHealthCause ───────────────────────────────────────────────

test('isPlausibleHealthCause: recognizes the documented example causes', () => {
  const yes = [
    'Had a few drinks with friends',
    'Feeling sick, might be coming down with something',
    'Just got back from a long flight, jet lagged',
    'Room was very hot last night',
    'Ate a big heavy dinner really late',
    'Started a new medication this week',
    'Really stressful day, big argument with my brother',
    'Unusual hard training session, way more intense than normal',
  ];
  for (const t of yes) assert.equal(cs.isPlausibleHealthCause(t), true, `"${t}" should be a plausible health cause`);
});

test('isPlausibleHealthCause: rejects unrelated content', () => {
  const no = ['Bought a new phone case', 'Watched a movie', 'Read a good book', ''];
  for (const t of no) assert.equal(cs.isPlausibleHealthCause(t), false, `"${t}" should not be a plausible health cause`);
});

// ── isFinancialAnnotation ────────────────────────────────────────────────

test('isFinancialAnnotation: spend/wealth/financial content is flagged regardless of category', () => {
  assert.equal(cs.isFinancialAnnotation({ category: 'brief_context', label: 'Spent $665 on vacation' }), true);
  assert.equal(cs.isFinancialAnnotation({ category: 'spending note', label: 'Vacation car rental' }), true);
  assert.equal(cs.isFinancialAnnotation({ category: 'illness', label: 'Down with a cold' }), false);
});

// ── isEligibleContext — 'health' purpose ─────────────────────────────────

test('isEligibleContext: the exact screenshot sentence is excluded from health context', () => {
  const annotation = {
    label: "I didnt end up going for drinks with friends tonight. Please forget that context.",
    category: 'brief_context',
    start_ts: new Date().toISOString(),
  };
  const result = cs.isEligibleContext(annotation, { purpose: 'health' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'retraction');
});

test('isEligibleContext: retired annotations are excluded from every purpose', () => {
  const annotation = { label: 'Had 3 drinks last night', retired_at: new Date().toISOString() };
  for (const purpose of ['health', 'wellbeing', 'general']) {
    assert.equal(cs.isEligibleContext(annotation, { purpose }).eligible, false, `${purpose} should exclude a retired annotation`);
  }
});

test('isEligibleContext: "Had 3 drinks last night" is eligible for next-morning RHR/HRV', () => {
  const tonight = new Date(); tonight.setHours(21, 0, 0, 0);
  const wake = new Date(tonight.getTime() + 10 * 60 * 60 * 1000); // ~7am next day
  const window = { start: new Date(tonight.getTime() - 3 * 60 * 60 * 1000), end: wake };
  const annotation = { label: 'Had 3 drinks last night', category: 'brief_context', start_ts: tonight.toISOString() };
  const result = cs.isEligibleContext(annotation, { purpose: 'health', window });
  assert.equal(result.eligible, true);
  assert.equal(result.confidence, 'high');
});

test('isEligibleContext: "I did not drink last night" is never an adverse causal explanation', () => {
  const window = { start: new Date(Date.now() - 12 * 3600 * 1000), end: new Date() };
  const annotation = { label: 'I did not drink last night', category: 'brief_context', start_ts: new Date().toISOString() };
  const result = cs.isEligibleContext(annotation, { purpose: 'health', window });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'negated');
});

test('isEligibleContext: "Planning drinks tonight" cannot explain last night\'s already-collected data', () => {
  const window = { start: new Date(Date.now() - 12 * 3600 * 1000), end: new Date() };
  const annotation = { label: 'Planning drinks tonight', category: 'brief_context', start_ts: new Date().toISOString() };
  const result = cs.isEligibleContext(annotation, { purpose: 'health', window });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'future-plan');
});

test('isEligibleContext: "Room was very hot last night" is eligible for sleep/RHR', () => {
  const evening = new Date(); evening.setHours(22, 0, 0, 0);
  const wake = new Date(evening.getTime() + 9 * 60 * 60 * 1000);
  const window = { start: new Date(evening.getTime() - 4 * 60 * 60 * 1000), end: wake };
  const annotation = { label: 'Room was very hot last night, could not cool down', category: 'brief_context', start_ts: evening.toISOString() };
  assert.equal(cs.isEligibleContext(annotation, { purpose: 'health', window }).eligible, true);
});

test('isEligibleContext: ongoing illness is eligible only during its active window', () => {
  const window = { start: new Date('2026-06-10T22:00:00Z'), end: new Date('2026-06-11T11:00:00Z') };
  const activeIllness = {
    label: 'Still sick with a cold', category: 'illness',
    start_ts: '2026-06-09T12:00:00Z', end_ts: '2026-06-12T12:00:00Z',
  };
  assert.equal(cs.isEligibleContext(activeIllness, { purpose: 'health', window }).eligible, true, 'illness active during the window should be eligible');

  const resolvedIllness = {
    label: 'Still sick with a cold', category: 'illness',
    start_ts: '2026-05-01T12:00:00Z', end_ts: '2026-05-04T12:00:00Z',
  };
  assert.equal(cs.isEligibleContext(resolvedIllness, { purpose: 'health', window }).eligible, false, 'illness resolved weeks before the window should not be eligible');
});

test('isEligibleContext: two-day-old expired context is excluded', () => {
  const window = { start: new Date('2026-06-10T22:00:00Z'), end: new Date('2026-06-11T11:00:00Z') };
  const annotation = {
    label: 'Had a few drinks with friends', category: 'brief_context',
    start_ts: '2026-06-08T22:00:00Z', // two nights before the window
  };
  assert.equal(cs.isEligibleContext(annotation, { purpose: 'health', window }).eligible, false);
});

test('isEligibleContext: same-day unrelated context (no backward reference) is excluded', () => {
  const window = { start: new Date('2026-06-10T22:00:00Z'), end: new Date('2026-06-11T11:00:00Z') };
  const annotation = {
    label: 'Feeling stressed about a deadline today', category: 'brief_context',
    start_ts: '2026-06-11T14:00:00Z', // same day, afternoon, no "last night"/"yesterday"
  };
  assert.equal(cs.isEligibleContext(annotation, { purpose: 'health', window }).eligible, false);
});

test('isEligibleContext: same-day context WITH an explicit backward reference is eligible', () => {
  const window = { start: new Date('2026-06-10T22:00:00Z'), end: new Date('2026-06-11T11:00:00Z') };
  const annotation = {
    label: 'Had a few drinks last night', category: 'brief_context',
    start_ts: '2026-06-11T09:00:00Z', // logged the morning after, explicitly backward-referencing
  };
  assert.equal(cs.isEligibleContext(annotation, { purpose: 'health', window }).eligible, true);
});

test('isEligibleContext: financial context is excluded from health', () => {
  const annotation = { label: 'Spent $665 on vacation flights', category: 'brief_context', start_ts: new Date().toISOString() };
  const result = cs.isEligibleContext(annotation, { purpose: 'health' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'financial');
});

test('isEligibleContext: without a window, health purpose falls back to content-only checks', () => {
  const annotation = { label: 'Had 3 drinks last night', category: 'brief_context', start_ts: new Date().toISOString() };
  assert.equal(cs.isEligibleContext(annotation, { purpose: 'health' }).eligible, true);
});

// ── isEligibleContext — 'wellbeing' purpose ──────────────────────────────

test('isEligibleContext: wellbeing purpose requires an emotional/psychological link', () => {
  assert.equal(cs.isEligibleContext({ label: "Didn't sleep home" }, { purpose: 'wellbeing' }).eligible, false);
  assert.equal(cs.isEligibleContext({ label: 'Stressful launch at work, big deadline' }, { purpose: 'wellbeing' }).eligible, true);
});

test('isEligibleContext: a retraction is excluded from wellbeing too', () => {
  const annotation = { label: 'Actually never mind, ignore what I said about being stressed' };
  assert.equal(cs.isEligibleContext(annotation, { purpose: 'wellbeing' }).eligible, false);
});

// ── isEligibleContext — 'general' purpose ────────────────────────────────

test('isEligibleContext: general purpose keeps planned/occurred/negated but excludes retraction/retired/financial', () => {
  assert.equal(cs.isEligibleContext({ label: 'Drinks with friends tonight' }, { purpose: 'general' }).eligible, true);
  assert.equal(cs.isEligibleContext({ label: 'Had 3 drinks last night' }, { purpose: 'general' }).eligible, true);
  assert.equal(cs.isEligibleContext({ label: 'I did not drink last night' }, { purpose: 'general' }).eligible, true);
  assert.equal(cs.isEligibleContext({ label: 'Please forget that context' }, { purpose: 'general' }).eligible, false);
  assert.equal(cs.isEligibleContext({ label: 'Had 3 drinks', retired_at: new Date().toISOString() }, { purpose: 'general' }).eligible, false);
  assert.equal(cs.isEligibleContext({ label: 'Spent $200 on dinner', category: 'brief_context' }, { purpose: 'general' }).eligible, false);
});

// ── filterEligible ────────────────────────────────────────────────────────

test('filterEligible drops ineligible entries and keeps the rest', () => {
  const annotations = [
    { label: 'Had 3 drinks last night' },
    { label: 'Please forget that context' },
    { label: 'Bought a new phone case' },
  ];
  const result = cs.filterEligible(annotations, { purpose: 'general' });
  assert.equal(result.length, 2);
  assert.ok(!result.some((a) => a.label.includes('forget')));
});

// ── findRetractionTarget ──────────────────────────────────────────────────

test('findRetractionTarget: matches the specific plan the retraction is walking back', () => {
  const candidates = [
    { id: 'a1', label: 'Drinks with friends tonight', note: null },
    { id: 'a2', label: 'Big presentation at work tomorrow', note: null },
  ];
  const target = cs.findRetractionTarget(
    "I didnt end up going for drinks with friends tonight. Please forget that context.",
    candidates
  );
  assert.ok(target, 'expected a match');
  assert.equal(target.id, 'a1');
});

test('findRetractionTarget: returns null when nothing overlaps enough to be unambiguous', () => {
  const candidates = [
    { id: 'a1', label: 'Big presentation at work tomorrow', note: null },
    { id: 'a2', label: 'Doctor appointment next week', note: null },
  ];
  const target = cs.findRetractionTarget('please forget that context', candidates);
  assert.equal(target, null);
});

test('findRetractionTarget: returns null when two candidates are ambiguously close', () => {
  const candidates = [
    { id: 'a1', label: 'Drinks with friends tonight', note: null },
    { id: 'a2', label: 'Drinks with coworkers tonight', note: null },
  ];
  const target = cs.findRetractionTarget('forget the drinks plan tonight', candidates);
  assert.equal(target, null, 'two closely-scoring candidates should not be guessed between');
});

test('findRetractionTarget: never matches an empty candidate list', () => {
  assert.equal(cs.findRetractionTarget('please forget that context', []), null);
});

// ── Timezone / DST boundaries ─────────────────────────────────────────────

test('isTemporallyAligned handles a spring-forward DST night correctly', () => {
  // America/New_York springs forward at 2am on 2026-03-08 (2am -> 3am).
  // Window: previous evening 6pm ET through 11am ET the next day.
  const window = {
    start: new Date('2026-03-07T23:00:00.000Z'), // 6pm EST (UTC-5, before the change)
    end: new Date('2026-03-08T15:00:00.000Z'),   // 11am EDT (UTC-4, after the change)
  };
  const loggedDuringNight = { label: 'Had a couple drinks', start_ts: '2026-03-08T02:30:00.000Z' };
  assert.equal(cs.isTemporallyAligned(loggedDuringNight, window, cs.EVENT_KIND.OCCURRED), true);

  const loggedTwoDaysEarlier = { label: 'Had a couple drinks', start_ts: '2026-03-05T23:00:00.000Z' };
  assert.equal(cs.isTemporallyAligned(loggedTwoDaysEarlier, window, cs.EVENT_KIND.OCCURRED), false);
});

test('isTemporallyAligned handles a fall-back DST night correctly', () => {
  // America/New_York falls back at 2am on 2026-11-01 (2am -> 1am).
  const window = {
    start: new Date('2026-10-31T22:00:00.000Z'), // 6pm EDT (UTC-4, before the change)
    end: new Date('2026-11-01T16:00:00.000Z'),   // 11am EST (UTC-5, after the change)
  };
  const loggedDuringNight = { label: 'Room was hot, jet lagged from a flight', start_ts: '2026-11-01T05:00:00.000Z' };
  assert.equal(cs.isTemporallyAligned(loggedDuringNight, window, cs.EVENT_KIND.OCCURRED), true);
});
