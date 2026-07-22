// Canonical nightly-context-tag history — the fix for a production
// temporal-grounding bug: a late_meal tag logged TWO NIGHTS AGO got restated
// by the Chief Brief as "the late-meal flag tonight can dent sleep" / "with
// a late meal on deck tonight" — a completed-night OBSERVATION rewritten as
// an invented FUTURE plan. This file covers the pure projection
// (intelligence/nightly-context-history.js) that closes the gap: every
// occurrence is dated, explicitly historical, and never implies "tonight".
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildNightlyContextHistory, renderNightlyContextHistoryPrompt,
} = require('../src/intelligence/nightly-context-history');

function series(pairs) {
  return pairs.map(([day, value]) => ({ day, value }));
}

// Required test 1 + 10: late_meal=1 two nights ago, no future plan — the
// prompt contains a DATED historical occurrence (the exact production
// fixture: "occurred on 1 of the last 3 completed nights... 2 nights ago").
test('required test 1: late_meal two nights ago produces a dated historical occurrence, not an ambiguous count', () => {
  const seriesByKey = { 'context:late_meal': series([['2026-07-20', 1]]) };
  const history = buildNightlyContextHistory(seriesByKey, { today: '2026-07-22', windowDays: 3 });
  assert.equal(history.length, 1);
  const h = history[0];
  assert.equal(h.tag, 'late_meal');
  assert.equal(h.loggedDays, 1);
  assert.equal(h.occurrences.length, 1);
  const occ = h.occurrences[0];
  // Required field list: concept/tag, status: occurred, nightEndingLocalDate,
  // age in completed nights, provenance, explicit not-a-plan indication.
  assert.equal(occ.concept, 'late_meal');
  assert.equal(occ.status, 'occurred');
  assert.equal(occ.nightEndingLocalDate, '2026-07-20');
  assert.equal(occ.ageNights, 2);
  assert.equal(occ.provenance, 'self_report');
  assert.equal(occ.isCurrentOrFuturePlan, false);
  assert.match(h.summary, /occurred on 1 of the last 3 completed nights/);
  assert.match(h.summary, /the night ending July 20 \(2 nights ago\)/);
  assert.match(h.summary, /Historical observation only — not evidence of a plan tonight\./);
  // "tonight" appears exactly once, and ONLY inside the disclaimer clause
  // ("not evidence of a plan tonight") — never as an affirmative framing of
  // the occurrence itself (e.g. never "late meal tonight").
  assert.equal((h.summary.match(/tonight/gi) || []).length, 1);
  assert.doesNotMatch(h.summary, /\bmeal tonight\b|\bon deck tonight\b|\bflag tonight\b/i);
});

// Required test 2: a positive tag on TODAY's wake-date is "last night", never "tonight".
test('required test 2: a positive tag on today\'s wake-date is described as last night, never tonight', () => {
  const seriesByKey = { 'context:late_meal': series([['2026-07-22', 1]]) };
  const history = buildNightlyContextHistory(seriesByKey, { today: '2026-07-22', windowDays: 3 });
  const h = history[0];
  assert.equal(h.occurrences[0].ageNights, 0);
  assert.match(h.summary, /latest occurrence was last night\./);
  // "tonight" appears only inside the disclaimer, never as "last night" being
  // recast into a same-night-as-today plan.
  assert.equal((h.summary.match(/tonight/gi) || []).length, 1);
  assert.doesNotMatch(h.summary, /\bmeal tonight\b|\bon deck tonight\b|\bflag tonight\b/i);
});

// Required test 5: no submission today (no row at all, not an explicit 0) is
// unknown, never rendered as a confirmed negative. Since this module only
// ever emits POSITIVE occurrences, an absent/untagged day never produces any
// "did not happen" claim — verified here by confirming an all-zero/empty
// series yields no entry and no negative-framed text at all.
test('required test 5: no context submission (or an all-zero window) is unknown, never an explicit negative claim', () => {
  // No series at all for this tag (never submitted).
  assert.deepEqual(buildNightlyContextHistory({}, { today: '2026-07-22' }), []);

  // Explicit zeros every day in the window — no occurrence, and critically no
  // "did not have a late meal" text is ever synthesized (this module simply
  // has nothing to report — it never asserts an absence as a fact).
  const seriesByKey = { 'context:late_meal': series([['2026-07-20', 0], ['2026-07-21', 0], ['2026-07-22', 0]]) };
  const history = buildNightlyContextHistory(seriesByKey, { today: '2026-07-22', windowDays: 3 });
  assert.deepEqual(history, []);
});

test('a genuine 3-night consecutive streak is reported as such, dated, most-recent-first', () => {
  const seriesByKey = { 'context:alcohol': series([['2026-07-20', 1], ['2026-07-21', 1], ['2026-07-22', 1]]) };
  const history = buildNightlyContextHistory(seriesByKey, { today: '2026-07-22', windowDays: 3 });
  const h = history[0];
  assert.equal(h.isConsecutiveStreak, true);
  assert.equal(h.streakDays, 3);
  assert.match(h.summary, /occurred 3 consecutive nights, most recently last night\./);
  assert.match(h.summary, /Historical observation only — not evidence of a plan tonight\./);
});

test('a gap anywhere in the window breaks the streak, even with the same total count', () => {
  const seriesByKey = { 'context:alcohol': series([['2026-07-20', 1], ['2026-07-21', 0], ['2026-07-22', 1]]) };
  const history = buildNightlyContextHistory(seriesByKey, { today: '2026-07-22', windowDays: 3 });
  const h = history[0];
  assert.equal(h.isConsecutiveStreak, false);
  assert.equal(h.loggedDays, 2);
  assert.match(h.summary, /occurred on 2 of the last 3 completed nights/);
});

// Required test 9: timezone and DST boundary coverage using America/New_York.
// Spring-forward: 2026-03-08 (EST, UTC-5) -> 2026-03-09 (EDT, UTC-4, the DST
// transition day) -> 2026-03-10. Calendar-day arithmetic on the date STRING
// (not wall-clock hours) must be unaffected by the lost/gained hour.
test('required test 9: DST spring-forward boundary (America/New_York, Mar 8-10 2026) does not corrupt night-ending dates or ages', () => {
  const seriesByKey = {
    'context:alcohol': series([['2026-03-08', 1], ['2026-03-09', 1], ['2026-03-10', 1]]),
  };
  const history = buildNightlyContextHistory(seriesByKey, { today: '2026-03-10', windowDays: 3 });
  const h = history[0];
  assert.equal(h.isConsecutiveStreak, true, 'the DST transition day must not silently break the streak');
  assert.equal(h.occurrences.length, 3);
  assert.deepEqual(
    h.occurrences.map((o) => o.nightEndingLocalDate),
    ['2026-03-10', '2026-03-09', '2026-03-08'],
    'each occurrence keeps its own exact calendar date across the DST boundary'
  );
  assert.deepEqual(h.occurrences.map((o) => o.ageNights), [0, 1, 2]);
});

// Fall-back: 2026-11-01 (EDT) -> 2026-11-02 (EST, the "extra hour" day).
test('DST fall-back boundary (America/New_York, Nov 1-2 2026) does not corrupt night-ending dates or ages', () => {
  const seriesByKey = { 'context:late_meal': series([['2026-11-01', 1]]) };
  const history = buildNightlyContextHistory(seriesByKey, { today: '2026-11-02', windowDays: 3 });
  const h = history[0];
  assert.equal(h.occurrences[0].nightEndingLocalDate, '2026-11-01');
  assert.equal(h.occurrences[0].ageNights, 1);
  assert.match(h.summary, /the night ending November 1 \(1 night ago\)/);
});

test('renderNightlyContextHistoryPrompt: empty history renders nothing', () => {
  assert.equal(renderNightlyContextHistoryPrompt([]), '');
  assert.equal(renderNightlyContextHistoryPrompt(null), '');
});

test('renderNightlyContextHistoryPrompt: non-empty history renders under a RECENT CONTEXT TAGS header with the not-a-plan instruction', () => {
  const seriesByKey = { 'context:late_meal': series([['2026-07-20', 1]]) };
  const history = buildNightlyContextHistory(seriesByKey, { today: '2026-07-22', windowDays: 3 });
  const rendered = renderNightlyContextHistoryPrompt(history);
  assert.match(rendered, /^RECENT CONTEXT TAGS/);
  assert.match(rendered, /NEVER/);
  assert.match(rendered, /- Late meal: occurred on 1 of the last 3 completed nights/);
});

test('multiple tags in the same window each get their own dated entry', () => {
  const seriesByKey = {
    'context:late_meal': series([['2026-07-20', 1]]),
    'context:alcohol': series([['2026-07-22', 1]]),
  };
  const history = buildNightlyContextHistory(seriesByKey, { today: '2026-07-22', windowDays: 3 });
  assert.equal(history.length, 2);
  const byTag = Object.fromEntries(history.map((h) => [h.tag, h]));
  assert.match(byTag.late_meal.summary, /2 nights ago/);
  assert.match(byTag.alcohol.summary, /last night/);
});
