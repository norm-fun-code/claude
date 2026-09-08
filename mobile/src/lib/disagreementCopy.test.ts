// Disagreement copy — the tone contract, made enforceable.
//
// Every other property of this surface is guarded on the server. What a test
// has to hold here is the thing most likely to erode later: that the card
// reports counts and asks a question, and never editorializes on top of them.
// One adjective is the difference between candour and contempt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatWeek, missedWeeksLine, basisLine, isFactualTone, type Disagreement } from './disagreementCopy.ts';

const TZ = 'America/New_York';

function disagreement(over: Partial<Disagreement> = {}): Disagreement {
  return {
    stableId: 'disagreement:snap1:morning-training',
    resolutionKey: 'disagreement:morning-training',
    kind: 'weekly_intention',
    label: 'morning training',
    headline: 'You’ve set “morning training” 6 weeks running.',
    detail: 'You marked it missed 5 of the 6 weeks you reviewed, and hit it 1.',
    weeksStated: ['2026-09-06', '2026-08-30', '2026-08-23', '2026-08-16', '2026-08-09', '2026-08-02'],
    weeksMissed: ['2026-09-06', '2026-08-30', '2026-08-16', '2026-08-09', '2026-08-02'],
    counts: { statements: 6, graded: 6, missed: 5, achieved: 1, unreviewed: 0 },
    question: 'Is the goal wrong, or the plan?',
    options: [
      { id: 'revise', label: 'Rewrite the goal', detail: '' },
      { id: 'keep', label: 'Keep it — fix the plan', detail: '' },
      { id: 'retire', label: 'Drop it', detail: '' },
    ],
    evidence: { source: 'weekly_intentions', basis: 'your own weekly goals and your own review of them', windowWeeks: 16, unreviewedExcluded: 0 },
    ...over,
  };
}

test('the tone guard actually catches an accusation', () => {
  // Guard the guard: a permissive regex here would silently make every other
  // tone assertion in this file vacuous.
  assert.equal(isFactualTone('You marked it missed 5 of 6 weeks.'), true);
  assert.equal(isFactualTone('You still haven’t done this.'), false);
  assert.equal(isFactualTone('You keep failing at this.'), false);
  assert.equal(isFactualTone('You should have done this weeks ago.'), false);
  assert.equal(isFactualTone('Disappointing again.'), false);
});

test('the server copy the card renders stays factual', () => {
  const d = disagreement();
  assert.ok(isFactualTone(d.headline), d.headline);
  assert.ok(isFactualTone(d.detail), d.detail);
  assert.ok(isFactualTone(basisLine(d)), basisLine(d));
});

test('the missed weeks are real dates the reader can check', () => {
  const line = missedWeeksLine(disagreement(), TZ);
  assert.match(line, /Sep 6/);
  assert.match(line, /Aug 2/);
});

test('a long list is capped and the remainder counted, never quietly dropped', () => {
  const d = disagreement({
    weeksMissed: ['2026-09-06', '2026-08-30', '2026-08-23', '2026-08-16', '2026-08-09', '2026-08-02', '2026-07-26', '2026-07-19'],
  });
  const line = missedWeeksLine(d, TZ);
  assert.match(line, /\+2 more/, 'the ones not shown must still be accounted for');
  assert.ok(line.split(',').length <= 7, 'a wall of dates reads as a charge sheet, not evidence');
});

test('no missed weeks renders nothing rather than an empty label', () => {
  assert.equal(missedWeeksLine(disagreement({ weeksMissed: [] }), TZ), '');
});

test('the basis line says the evidence is the reader’s own words and grading', () => {
  assert.match(basisLine(disagreement()), /your own weekly goals and your own review/);
});

test('unreviewed weeks are stated as excluded, so silence is never read as failure', () => {
  const line = basisLine(disagreement({
    counts: { statements: 8, graded: 6, missed: 5, achieved: 1, unreviewed: 2 },
    evidence: { source: 'weekly_intentions', basis: 'your own weekly goals and your own review of them', windowWeeks: 16, unreviewedExcluded: 2 },
  }));
  assert.match(line, /2 weeks you didn’t review are not counted/);
});

test('one unreviewed week reads as singular', () => {
  const line = basisLine(disagreement({
    evidence: { source: 'weekly_intentions', basis: 'your own weekly reviews', windowWeeks: 16, unreviewedExcluded: 1 },
  }));
  assert.match(line, /1 week you didn’t review is not counted/);
});

test('week dates do not drift a day in a western timezone', () => {
  assert.equal(formatWeek('2026-09-06', TZ), 'Sep 6');
  assert.equal(formatWeek('2026-09-06', 'America/Los_Angeles'), 'Sep 6');
});
