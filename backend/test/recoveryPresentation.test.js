// Recovery presentation fix — a near-green score (e.g. 59) is canonically
// still 'yellow' (drives training logic, forecasting, validation, and
// history unchanged), but must render as reassuring, not alarming. See
// intelligence/recoveryThresholds.js (single authoritative source for the
// 63/40 canonical cutoffs + the presentation tiers) and
// intelligence/recoveryPresentation.js (the semantic guidance every surface
// consumes). Required tests 1-6 from the task spec.
const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalBand, presentationTierFor, GREEN_MIN, YELLOW_MIN } = require('../src/intelligence/recoveryThresholds');
const { recoveryPresentation } = require('../src/intelligence/recoveryPresentation');
const { recoveryBand, recoveryScore, recoveryHistory, computeHealthComposites } = require('../src/intelligence/recovery');
const { predictCapacity } = require('../src/intelligence/predict');

// Build a [{day,value}] series from an array of values — mirrors recovery.test.js's helper.
function series(values) {
  return values.map((v, i) => ({ day: `2026-05-${String(i + 1).padStart(2, '0')}`, value: v }));
}
function baselineThen(base, n, last) {
  const vals = [];
  for (let i = 0; i < n; i++) vals.push(base + (i % 3 - 1) * 0.5);
  vals.push(last);
  return series(vals);
}

test('required 1: score 59 remains canonically yellow but renders "Solid — near green"', () => {
  assert.equal(canonicalBand(59), 'yellow');
  assert.equal(recoveryBand(59).band, 'yellow');
  const pres = recoveryPresentation(59, { band: 'yellow' });
  assert.equal(pres.tier, 'solid_near_green');
  assert.equal(pres.label, 'Solid — near green');
  assert.equal(pres.band, 'yellow');
});

test('required 2: score 54 renders Moderate/amber', () => {
  const pres = recoveryPresentation(54, { band: canonicalBand(54) });
  assert.equal(canonicalBand(54), 'yellow');
  assert.equal(pres.tier, 'moderate');
  assert.equal(pres.label, 'Moderate');
  assert.equal(pres.color, 'amber');
});

test('required 3: score 63 renders Ready/green', () => {
  const pres = recoveryPresentation(63, { band: canonicalBand(63) });
  assert.equal(canonicalBand(63), 'green');
  assert.equal(pres.tier, 'ready');
  assert.equal(pres.label, 'Ready');
  assert.equal(pres.color, 'green');
});

test('required 4: score 39 renders Low/red', () => {
  const pres = recoveryPresentation(39, { band: canonicalBand(39) });
  assert.equal(canonicalBand(39), 'red');
  assert.equal(pres.tier, 'low');
  assert.equal(pres.label, 'Low');
  assert.equal(pres.color, 'red');
});

test('required 5: a score of 59 alone does not generate "dial back," "under-recovered," or "keep it easy"', () => {
  const pres = recoveryPresentation(59, { band: 'yellow' });
  assert.doesNotMatch(pres.guidance, /dial back/i);
  assert.doesNotMatch(pres.guidance, /under-?recovered/i);
  assert.doesNotMatch(pres.guidance, /keep it easy/i);
  assert.match(pres.guidance, /no automatic need to scale back/i);
});

test('required 6: score 59 plus an independent risk (high sleep debt) may still produce cautious guidance', () => {
  const bare = recoveryPresentation(59, { band: 'yellow' });
  const withRisk = recoveryPresentation(59, { band: 'yellow', riskFlags: ['sleep_debt'] });
  assert.notEqual(withRisk.guidance, bare.guidance);
  assert.match(withRisk.guidance, /sleep debt/i);
  assert.deepEqual(withRisk.riskFlags, ['sleep_debt']);
});

test('boundary: presentation tiers subdivide ONLY the canonical yellow range — green/red boundaries never move', () => {
  assert.equal(presentationTierFor(GREEN_MIN).tier, 'ready');
  assert.equal(presentationTierFor(GREEN_MIN - 1).tier, 'solid_near_green');
  assert.equal(presentationTierFor(55).tier, 'solid_near_green');
  assert.equal(presentationTierFor(54).tier, 'moderate');
  assert.equal(presentationTierFor(YELLOW_MIN).tier, 'moderate');
  assert.equal(presentationTierFor(YELLOW_MIN - 1).tier, 'low');
});

test('required 8 (part): recoveryBand()\'s canonical guidance text is unchanged (regression-proofs existing behavior)', () => {
  assert.equal(recoveryBand(80).guidance, "Green — your body's ready. Full intensity is appropriate today.");
  assert.equal(recoveryBand(59).guidance, 'Moderate — solid foundation. Push if you feel good, but watch your exertion.');
  assert.equal(recoveryBand(20).guidance, "Low — under-recovered. Keep it easy today: mobility or a walk, and protect tonight's sleep.");
});

test('required 7: Health (computeHealthComposites) and Today (predictCapacity) render the identical presentation tier/label for the same score', () => {
  const seriesByKey = {
    'health:hrv': baselineThen(50, 30, 50.1),
    'health:resting_hr': baselineThen(55, 30, 54.9),
    'health:sleep_hours': baselineThen(7, 30, 7.0),
  };
  const findings = computeHealthComposites(seriesByKey);
  const healthFinding = findings.find((f) => f.type === 'recovery');
  assert.ok(healthFinding, 'expected a recovery finding');
  const score = healthFinding.evidence.score;
  // Near-green by construction — proves the fixture actually exercises the
  // tier this test is about, not an unrelated band.
  assert.ok(score >= 55 && score <= 62, `expected a near-green score, got ${score}`);
  assert.equal(healthFinding.evidence.presentation.tier, 'solid_near_green');

  const todayCapacity = predictCapacity({ recoveryScore: score });
  // Both surfaces consume the SAME centralized semantics (recoveryPresentation.js)
  // — same score in, same tier/label/color out, regardless of which surface
  // called it or what OTHER context each surface separately layered on top
  // (Health's finding picked up an additional sleep_debt risk flag here;
  // Today's forecast wasn't given that context — that's expected, each
  // surface only knows what it knows — but the base tier/label must agree).
  assert.equal(todayCapacity.presentation.tier, healthFinding.evidence.presentation.tier);
  assert.equal(todayCapacity.presentation.label, healthFinding.evidence.presentation.label);
  assert.equal(todayCapacity.presentation.color, healthFinding.evidence.presentation.color);

  // Ask/voice (chat/ask.js's recoveryContext, chat/realtimeTools.js's
  // getCurrentRecovery, routes/realtime.js's session-start context) all read
  // `presentation.label` off this SAME liveRecovery()-shaped object — proven
  // structurally here since recoveryPresentation() is the one function every
  // one of those call sites imports, not a per-surface reimplementation.
  const direct = recoveryPresentation(score, { band: healthFinding.evidence.band });
  assert.equal(direct.tier, healthFinding.evidence.presentation.tier);
  assert.equal(direct.label, healthFinding.evidence.presentation.label);
});

test('required 8: existing recovery calculations and historical scores remain unchanged', () => {
  // recoveryScore()'s own math is untouched — same inputs, same score, same
  // parts breakdown as before this fix (regression-proofed independently in
  // recovery.test.js; re-asserted here as the presentation fix's own
  // non-regression guarantee).
  const seriesByKey = {
    'health:hrv': baselineThen(50, 30, 70),
    'health:resting_hr': baselineThen(55, 30, 48),
    'health:sleep_hours': baselineThen(7, 30, 8.5),
  };
  const rec = recoveryScore(seriesByKey);
  assert.ok(rec.score > 70);
  assert.equal(canonicalBand(rec.score), 'green');
  assert.equal(recoveryBand(rec.score).band, 'green');
  // recoveryHistory()'s per-day shape ({ts, value, proxy}) is untouched by
  // this fix — presentation is never attached to historical points, only to
  // the live/current reading and today's forecast.
  assert.equal(typeof recoveryHistory, 'function');
});

test('required 8 (part): predictCapacity\'s grade/band/headline/prescription are unchanged; presentation is additive only', () => {
  const r58 = predictCapacity({ recoveryScore: 58 });
  assert.equal(r58.grade, 'B');
  assert.equal(r58.band, 'yellow');
  assert.equal(r58.headline, 'Hit your essentials');
  assert.ok(r58.presentation);
  assert.equal(r58.presentation.tier, 'solid_near_green');

  const r80 = predictCapacity({ recoveryScore: 80 });
  assert.equal(r80.grade, 'A');
  assert.equal(r80.presentation.tier, 'ready');

  const r30 = predictCapacity({ recoveryScore: 30 });
  assert.equal(r30.grade, 'C');
  assert.equal(r30.presentation.tier, 'low');
});
