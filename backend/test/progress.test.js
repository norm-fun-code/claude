const test = require('node:test');
const assert = require('node:assert/strict');
const { composeProgressNote } = require('../src/intelligence/progress');

// `p` here stands in for a pre-computed Welch p-value (composeProgressNote
// accepts either a raw `p` or `recent.vals`/`baseline.vals` to compute one
// itself) — 0.001 is a stand-in "clearly significant" result so tests that
// aren't specifically about the significance gate don't need to construct
// realistic per-day value arrays.
const row = (over = {}) => ({
  label: 'HRV', unit: 'ms', good: 'up', decimals: 0, minRel: 0.05,
  recent: { avg: 52, n: 24 }, baseline: { avg: 47, n: 22 }, p: 0.001,
  ...over,
});

test('a real improvement is reported with both values and the % change', () => {
  const note = composeProgressNote([row()]);
  assert.ok(note, 'expected a note');
  assert.match(note, /HRV 52ms now vs 47ms then/);
  assert.match(note, /\+11%/);
  assert.doesNotMatch(note, /wrong way/);
});

test('a regression is included and honestly labeled', () => {
  const note = composeProgressNote([
    row({ label: 'resting HR', unit: 'bpm', good: 'down', minRel: 0.03, recent: { avg: 58, n: 20 }, baseline: { avg: 54, n: 20 } }),
  ]);
  assert.match(note, /resting HR 58bpm now vs 54bpm then/);
  assert.match(note, /moving the wrong way/);
});

test('sub-threshold drift stays silent', () => {
  // +2% on a 5% relative gate → nothing worth saying.
  const note = composeProgressNote([row({ recent: { avg: 48, n: 24 } })]);
  assert.equal(note, null);
});

test('thin data in either window disqualifies the metric', () => {
  assert.equal(composeProgressNote([row({ recent: { avg: 60, n: 4 } })]), null);
  assert.equal(composeProgressNote([row({ baseline: { avg: 40, n: 4 } })]), null);
});

test('/5 scales gate on absolute change and render as e.g. 4.1/5 (+0.5)', () => {
  const note = composeProgressNote([
    row({ label: 'mood', unit: '/5', minRel: undefined, minAbs: 0.3, decimals: 1, recent: { avg: 4.1, n: 15 }, baseline: { avg: 3.6, n: 14 } }),
  ]);
  assert.match(note, /mood 4\.1\/5 now vs 3\.6\/5 then/);
  assert.match(note, /\+0\.5/);
  // A 0.2 shift on the same gate stays silent.
  assert.equal(
    composeProgressNote([row({ label: 'mood', unit: '/5', minRel: undefined, minAbs: 0.3, decimals: 1, recent: { avg: 3.8, n: 15 }, baseline: { avg: 3.6, n: 14 } })]),
    null
  );
});

test('adherence rates render as % of days with a point-change annotation', () => {
  const note = composeProgressNote([
    row({ label: 'morning meditation', unit: '%days', minRel: undefined, minAbs: 0.15, decimals: 0, recent: { avg: 0.86, n: 26 }, baseline: { avg: 0.62, n: 25 } }),
  ]);
  assert.match(note, /morning meditation 86% of days now vs 62% of days then/);
  assert.match(note, /\+24 pts/);
});

test('caps at three lines, strongest relative shifts first', () => {
  const rows = [
    row({ label: 'HRV', recent: { avg: 52, n: 20 }, baseline: { avg: 47, n: 20 } }),                                  // +11%
    row({ label: 'sleep', unit: 'h', minRel: 0.04, decimals: 1, recent: { avg: 7.6, n: 20 }, baseline: { avg: 7.0, n: 20 } }), // +9%
    row({ label: 'resting HR', unit: 'bpm', good: 'down', minRel: 0.03, recent: { avg: 51, n: 20 }, baseline: { avg: 57, n: 20 } }), // −11%
    row({ label: 'VO₂ max', unit: '', minRel: undefined, minAbs: 0.5, decimals: 1, minN: 2, recent: { avg: 44.0, n: 3 }, baseline: { avg: 41.0, n: 2 } }), // +7%
  ];
  const note = composeProgressNote(rows);
  const parts = note.split(' · ');
  assert.equal(parts.length, 3, 'must cap at three');
  assert.match(parts[0], /HRV|resting HR/, 'strongest shifts lead');
  assert.doesNotMatch(note, /VO₂/, 'weakest qualifying shift is the one dropped');
});

test('empty input and missing windows return null', () => {
  assert.equal(composeProgressNote([]), null);
  assert.equal(composeProgressNote([{ label: 'HRV', unit: 'ms', good: 'up', minRel: 0.05, recent: null, baseline: { avg: 5, n: 20 } }]), null);
});

test('a mean gap that clears the threshold but is not statistically significant stays silent', () => {
  // Same +11% gap as the first test, but p is above the 0.05 bar (e.g. a noisy,
  // widely-overlapping pair of samples) — must not be reported as "real".
  const note = composeProgressNote([row({ p: 0.4 })]);
  assert.equal(note, null);
});

test('a row with no supplied p and no raw vals to test cannot qualify', () => {
  const note = composeProgressNote([row({ p: undefined })]);
  assert.equal(note, null);
});

test('significance is computed from raw per-day values when p is not pre-supplied', () => {
  // Cleanly separated distributions -> real Welch p well under 0.05.
  const clean = composeProgressNote([
    row({
      p: undefined,
      recent: { avg: 52, n: 20, vals: Array.from({ length: 20 }, (_, i) => 51 + (i % 3)) },
      baseline: { avg: 47, n: 20, vals: Array.from({ length: 20 }, (_, i) => 46 + (i % 3)) },
    }),
  ]);
  assert.ok(clean, 'a clean separation should qualify via a real Welch test');

  // Same means, but wildly noisy/overlapping raw values -> high p, excluded.
  const noisy = composeProgressNote([
    row({
      p: undefined,
      recent: { avg: 52, n: 20, vals: [10, 90, 20, 84, 15, 88, 12, 92, 18, 86, 22, 80, 9, 95, 25, 78, 30, 74, 5, 99] },
      baseline: { avg: 47, n: 20, vals: [8, 85, 92, 12, 79, 18, 88, 22, 76, 14, 90, 20, 82, 16, 94, 24, 72, 28, 68, 96] },
    }),
  ]);
  assert.equal(noisy, null);
});
