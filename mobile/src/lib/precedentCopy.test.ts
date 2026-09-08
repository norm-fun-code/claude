// Precedent card copy — the rule under test is that the words never claim
// more than the projection contains.
//
// The backend decides IF there is anything to say (test/precedent.test.js
// covers those gates against a real database). These tests cover the other
// half of the same contract: that a withheld comparison stays withheld, that a
// sign is never dropped from a recovery movement, and that the count, the
// window and the method are always stated so the card can be checked by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDay,
  formatWindow,
  formatDelta,
  magnitudeWord,
  describeStateItem,
  stateSummary,
  headlineCount,
  comparisonLines,
  methodNote,
  closestWithOutcome,
  COMPARISON_CAVEAT,
  type Precedent,
} from './precedentCopy.ts';

const TZ = 'America/New_York';

function precedent(over: Partial<Precedent> = {}): Precedent {
  return {
    asOf: '2026-09-08',
    count: 9,
    earliest: '2026-05-11',
    latest: '2026-08-29',
    state: [
      { key: 'health:hrv', label: 'HRV', z: -1.8, value: 38, direction: 'below' },
      { key: 'health:sleep_hours', label: 'Sleep', z: -1.2, value: 5.6, direction: 'below' },
    ],
    precedents: [
      { day: '2026-08-29', similarity: 96, sharedFeatures: 4, recovery: 54, nextDayDelta: -6, load: 910 },
      { day: '2026-07-20', similarity: 92, sharedFeatures: 4, recovery: 57, nextDayDelta: 7, load: 180 },
    ],
    comparison: null,
    evidence: {
      minSimilarity: 0.8, minSharedFeatures: 3, baselineDays: 28,
      withOutcome: 8, leverMetric: 'health:active_energy', outcomeMetric: 'recovery next day',
    },
    ...over,
  };
}

test('a withheld comparison stays withheld — it is never softened into a suggestion', () => {
  assert.equal(comparisonLines(null), null);
  assert.equal(comparisonLines(precedent().comparison), null);
});

test('a supported comparison renders both arms with their real counts, lighter first', () => {
  const lines = comparisonLines({
    cutoff: 500,
    lighter: { n: 5, days: [], meanNextDayDelta: 7.4, meanLoad: 190 },
    harder: { n: 4, days: [], meanNextDayDelta: -5.5, meanLoad: 920 },
  })!;
  assert.equal(lines.length, 2);
  assert.equal(lines[0].label, 'The 5 times you kept the day lighter');
  assert.equal(lines[1].label, 'The 4 times you went harder');
  assert.equal(lines[0].delta, '+7.4');
  assert.equal(lines[1].delta, '−5.5');
  assert.equal(lines[0].direction, 'up');
  assert.equal(lines[1].direction, 'down');
});

test('a single-day arm is not pluralized into sounding like a pattern', () => {
  const lines = comparisonLines({
    cutoff: 500,
    lighter: { n: 1, days: ['2026-06-01'], meanNextDayDelta: 5, meanLoad: 100 },
    harder: { n: 6, days: [], meanNextDayDelta: -1, meanLoad: 900 },
  })!;
  assert.equal(lines[0].label, 'The 1 time you kept the day lighter');
});

test('the sign of a recovery movement is never dropped', () => {
  assert.equal(formatDelta(8), '+8');
  assert.equal(formatDelta(-4.26), '−4.3');
  assert.equal(formatDelta(7.41), '+7.4');
  assert.equal(formatDelta(0.04), 'no change', 'a rounded-to-zero move must not render as a bare 0');
  assert.ok(!formatDelta(-4).startsWith('-'), 'uses a true minus sign, not a hyphen');
});

test('the caveat exists and refuses both prediction and recommendation', () => {
  assert.match(COMPARISON_CAVEAT, /not what will/i);
  assert.match(COMPARISON_CAVEAT, /not a prediction or a recommendation/i);
});

test('state phrasing carries the observed value so the claim can be checked', () => {
  assert.equal(
    describeStateItem({ key: 'health:hrv', label: 'HRV', z: -1.8, value: 38, direction: 'below' }),
    'HRV well below usual (38)'
  );
  assert.equal(
    describeStateItem({ key: 'health:resting_hr', label: 'Resting HR', z: 2.4, value: 60, direction: 'above' }),
    'Resting HR far above usual (60)'
  );
  assert.equal(
    describeStateItem({ key: 'health:sleep_score', label: 'Sleep score', z: -0.4, value: null, direction: 'below' }),
    'Sleep score slightly below usual',
    'a feature with no displayable value still reads as a sentence'
  );
});

test('magnitude words are coarse and monotonic', () => {
  assert.equal(magnitudeWord(0.5), 'slightly');
  assert.equal(magnitudeWord(-1.4), 'well');
  assert.equal(magnitudeWord(3), 'far');
});

test('the state summary lists what actually made today distinctive', () => {
  const s = stateSummary(precedent().state);
  assert.match(s, /HRV well below usual \(38\)/);
  assert.match(s, /Sleep well below usual \(5\.6\)/);
  assert.ok(s.endsWith('.'));
});

test('an empty state summary is empty, not a filler sentence', () => {
  assert.equal(stateSummary([]), '');
});

test('the count is phrased as what was retrieved, and never mis-pluralized', () => {
  assert.equal(headlineCount(9), '9 mornings like this one');
  assert.equal(headlineCount(1), '1 morning like this one');
});

test('dates render in the reader timezone without drifting a day', () => {
  assert.equal(formatDay('2026-08-29', TZ), 'Aug 29');
  assert.equal(formatDay('2026-08-29', 'America/Los_Angeles'), 'Aug 29');
  assert.equal(formatWindow(precedent(), TZ), 'May 11 – Aug 29');
});

test('the method note states the window and baseline, so the card is auditable', () => {
  const note = methodNote(precedent(), TZ);
  assert.match(note, /28-day rolling baseline/);
  assert.match(note, /May 11 – Aug 29/);
});

test('the closest match is only offered when that day actually has an outcome', () => {
  assert.equal(closestWithOutcome(precedent())!.day, '2026-08-29');
  const noOutcomes = precedent({
    precedents: [{ day: '2026-08-29', similarity: 96, sharedFeatures: 4, recovery: 54, nextDayDelta: null, load: 910 }],
  });
  assert.equal(closestWithOutcome(noOutcomes), null);
});
