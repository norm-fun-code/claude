const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../src/intelligence/analyze');

// Build a [{day,value}] series of `n` days from a generator.
function mkSeries(n, fn, startISO = '2026-04-01T12:00:00') {
  const out = [];
  const start = new Date(startISO);
  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    out.push({ day: d.toISOString().slice(0, 10), value: fn(i) });
  }
  return out;
}

test('computeSleepImpact: surfaces best-vs-worst-night outcome splits', () => {
  const N = 42;
  // Sleep score cycles 60..90; HRV tracks it (higher on better-slept indices).
  const sleepScore = mkSeries(N, (i) => 60 + (i % 7) * 5);
  const hrv = mkSeries(N, (i) => 45 + (i % 7) * 3);
  const findings = a.computeSleepImpact({
    'health:sleep_score': sleepScore,
    'health:hrv': hrv,
  });
  const hrvF = findings.find((f) => f.evidence.outcome === 'health:hrv');
  assert.ok(hrvF, 'expected an HRV sleep-impact finding');
  assert.equal(hrvF.type, 'sleep_impact');
  assert.ok(hrvF.evidence.goodMean > hrvF.evidence.poorMean, 'good nights should show higher HRV');
  assert.ok(hrvF.evidence.goodN >= 5 && hrvF.evidence.poorN >= 5);
});

test('computeSleepImpact: returns nothing without enough nights', () => {
  const short = mkSeries(6, () => 70);
  assert.deepEqual(a.computeSleepImpact({ 'health:sleep_score': short, 'health:hrv': short }), []);
});

test('computeSleepImpact: falls back to sleep_hours when sleep_score is flat', () => {
  const N = 42;
  const flatScore = mkSeries(N, () => 80);          // no spread — old code bailed here
  const hours = mkSeries(N, (i) => 6 + (i % 7) * 0.5); // sleep_hours varies plenty
  const hrv = mkSeries(N, (i) => 45 + (i % 7) * 3);    // HRV tracks hours
  const findings = a.computeSleepImpact({
    'health:sleep_score': flatScore,
    'health:sleep_hours': hours,
    'health:hrv': hrv,
  });
  const hrvF = findings.find((f) => f.evidence.outcome === 'health:hrv');
  assert.ok(hrvF, 'expected a sleep-impact finding driven by sleep_hours');
  assert.equal(hrvF.evidence.driver, 'health:sleep_hours');
});

test('computeTrends: derived sleep_debt/sleep_need never produce a trend', () => {
  const N = 20;
  const debt = mkSeries(N, (i) => (i < 10 ? 0.7 : 0.2)); // a big % "drop" — but derived
  const need = mkSeries(N, (i) => 7 + (i < 10 ? 0 : 1));  // a big % "rise" — but derived
  const findings = a.computeTrends({ 'health:sleep_debt': debt, 'health:sleep_need': need });
  assert.equal(findings.length, 0, 'derived sleep intermediates must not trend');
});

test('computeCorrelations: VO₂ max and sleep_need are excluded from the engine', () => {
  const N = 30;
  // Strongly related series that WOULD survive the engine without the skip.
  const vo2 = mkSeries(N, (i) => 50 + (i % 6));
  const need = mkSeries(N, (i) => 8 - (i % 6) * 0.1);
  const hrv = mkSeries(N, (i) => 45 + (i % 6));
  // Respiratory rate vs mood: strong but spurious — must be excluded too.
  const resp = mkSeries(N, (i) => 14 + (i % 6) * 0.3);
  const mood = mkSeries(N, (i) => 3 + (i % 6) * 0.2);
  const findings = a.computeCorrelations({
    'health:vo2_max': vo2, 'health:sleep_need': need, 'health:hrv': hrv,
    'health:respiratory_rate': resp, 'wellbeing:mood': mood,
  });
  for (const f of findings) {
    const { a: ka, b: kb } = f.evidence;
    for (const blocked of ['health:vo2_max', 'health:sleep_need', 'health:respiratory_rate']) {
      assert.ok(ka !== blocked && kb !== blocked, `no ${blocked} correlation should surface`);
    }
  }
});

test('computeTrends: binary habits are skipped (no "+133% cold shower" noise)', () => {
  // 14 days: cold shower 3/7 early, 7/7 late — a huge raw "trend" that is meaningless.
  const coldShower = mkSeries(14, (i) => (i < 7 ? (i % 2) : 1));
  const exercise = mkSeries(14, (i) => (i < 7 ? (i % 3 === 0 ? 1 : 0) : 1));
  const findings = a.computeTrends({
    'habits:cold_shower': coldShower,
    'habits:exercise': exercise,
  });
  assert.equal(findings.length, 0, 'binary-habit trends should be suppressed');
});

test('computeAnomalies: labels a prior-day standout "yesterday", not "today"', () => {
  // 20 days of mood ~4.0 ending on a clearly-past date, with a 5.0 final spike.
  const mood = mkSeries(20, (i) => (i === 19 ? 5 : 4 + ((i % 3) - 1) * 0.3), '2026-05-01T12:00:00');
  const findings = a.computeAnomalies({ 'wellbeing:mood': mood });
  const moodF = findings.find((f) => f.evidence.metric === 'wellbeing:mood');
  assert.ok(moodF, 'expected a mood anomaly');
  assert.match(moodF.detail, /yesterday/);
  assert.doesNotMatch(moodF.detail, /\btoday\b/);
});

test('computeActivityImpact: flags an exercise type that costs next-day recovery', () => {
  const N = 40;
  const cycle = ['zone2', 'pull', 'intervals', 'push', 'zone2'];
  const activityTypeByDay = {};
  const start = new Date('2026-04-01T12:00:00');
  for (let i = 0; i < N; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    activityTypeByDay[d.toISOString().slice(0, 10)] = cycle[i % cycle.length];
  }
  // Next-day HRV is suppressed the day after intervals, normal otherwise.
  const hrv = mkSeries(N, (i) => (cycle[(i - 1 + cycle.length) % cycle.length] === 'intervals' ? 42 : 54));
  const findings = a.computeActivityImpact({ 'health:hrv': hrv }, activityTypeByDay);
  const f = findings.find((x) => x.evidence.outcome === 'health:hrv');
  assert.ok(f, 'expected an HRV activity-impact finding');
  assert.equal(f.evidence.activity, 'intervals');
  assert.ok(f.evidence.pct < 0, 'intervals should depress next-day HRV vs typical');
});

test('computeActivityImpact: returns nothing with too little data', () => {
  assert.deepEqual(a.computeActivityImpact({ 'health:hrv': mkSeries(3, () => 50) }, { '2026-04-01': 'pull' }), []);
});

test('computeDaytimeCardio: surfaces eating→daytime-HRV split', () => {
  const N = 30;
  // Eat-healthy alternates high (4) / low (1); daytime HRV is higher on eat-well days.
  const eat = mkSeries(N, (i) => (i % 2 === 0 ? 4 : 1));
  const hrvDay = mkSeries(N, (i) => (i % 2 === 0 ? 50 : 38));
  const findings = a.computeDaytimeCardio({
    'health:hrv_daytime': hrvDay,
    'habits:eat_healthy': eat,
  });
  const f = findings.find((x) => x.evidence.outcome === 'health:hrv_daytime');
  assert.ok(f, 'expected a daytime-HRV finding');
  assert.equal(f.type, 'daytime_cardio');
  assert.equal(f.evidence.lever, 'habits:eat_healthy');
  assert.ok(f.evidence.hiMean > f.evidence.loMean, 'eat-well days should show higher daytime HRV');
  assert.ok(f.evidence.hiN >= 5 && f.evidence.loN >= 5);
});

test('computeDaytimeCardio: RHR lever uses mood and respects good=down direction', () => {
  const N = 30;
  // High-mood days (>=4) pair with LOWER daytime RHR (better autonomic tone).
  const mood = mkSeries(N, (i) => (i % 2 === 0 ? 5 : 2));
  const rhrDay = mkSeries(N, (i) => (i % 2 === 0 ? 56 : 64));
  const findings = a.computeDaytimeCardio({
    'health:rhr_daytime': rhrDay,
    'wellbeing:mood': mood,
  });
  const f = findings.find((x) => x.evidence.outcome === 'health:rhr_daytime');
  assert.ok(f, 'expected a daytime-RHR finding');
  assert.equal(f.evidence.lever, 'wellbeing:mood');
  assert.ok(f.evidence.hiMean < f.evidence.loMean, 'high-mood days should show lower RHR');
  // good=down + lower-on-high → the narrative should frame it as an improvement.
  assert.match(f.detail, /better autonomic tone/);
});

test('computeDaytimeCardio: isolated — ignores nighttime keys entirely', () => {
  // Only nighttime keys present (no _daytime series). Must produce nothing, so it
  // can never accidentally analyze the Eight-Sleep-locked recovery series.
  const N = 30;
  const findings = a.computeDaytimeCardio({
    'health:hrv': mkSeries(N, (i) => 45 + (i % 2) * 10),
    'health:resting_hr': mkSeries(N, (i) => 60 - (i % 2) * 5),
    'habits:eat_healthy': mkSeries(N, (i) => (i % 2 === 0 ? 4 : 1)),
  });
  assert.deepEqual(findings, [], 'no _daytime series → no findings; nighttime keys must be ignored');
});

test('computeDaytimeCardio: returns nothing without enough days per bucket', () => {
  const short = mkSeries(6, (i) => (i % 2 === 0 ? 50 : 40));
  const eat = mkSeries(6, (i) => (i % 2 === 0 ? 4 : 1));
  assert.deepEqual(
    a.computeDaytimeCardio({ 'health:hrv_daytime': short, 'habits:eat_healthy': eat }),
    []
  );
});

test('computeDaytimeCardio: a noisy ~6% gap is NOT surfaced (significance gate)', () => {
  // Eat-well vs other days differ by only a few percent on average, but the
  // within-group day-to-day spread is large — exactly the kind of sampling noise
  // the OLD raw-mean engine would have mislabeled "Eating well: HRV +6%".
  const N = 30;
  // High variance on BOTH buckets, tiny true mean shift.
  const hiNoise = [50, 38, 62, 41, 58, 36, 60, 44, 55, 40, 64, 39, 57, 42, 59];
  const loNoise = [44, 60, 38, 56, 41, 59, 37, 62, 40, 54, 43, 58, 39, 61, 45];
  let hI = 0, lI = 0;
  const hrvDay = mkSeries(N, (i) => (i % 2 === 0 ? hiNoise[hI++] : loNoise[lI++]));
  const eat = mkSeries(N, (i) => (i % 2 === 0 ? 4 : 1));
  const findings = a.computeDaytimeCardio({ 'health:hrv_daytime': hrvDay, 'habits:eat_healthy': eat });
  assert.deepEqual(findings, [], 'noisy, overlapping buckets must not produce a finding');
});

test('computeDaytimeCardio: surfaced findings carry a p-value, effect size, and CI', () => {
  const N = 30;
  const eat = mkSeries(N, (i) => (i % 2 === 0 ? 4 : 1));
  const hrvDay = mkSeries(N, (i) => (i % 2 === 0 ? 50 : 38));
  const f = a.computeDaytimeCardio({ 'health:hrv_daytime': hrvDay, 'habits:eat_healthy': eat })
    .find((x) => x.evidence.outcome === 'health:hrv_daytime');
  assert.ok(f, 'expected a finding on cleanly-separated data');
  assert.ok(f.evidence.p != null && f.evidence.p < 0.05, 'evidence should carry a significant p');
  assert.ok(Number.isFinite(f.evidence.cohenD), 'evidence should carry Cohen d');
  assert.ok(Array.isArray(f.evidence.ci) && f.evidence.ci.length === 2, 'evidence should carry a CI');
});

test('computeAnomalies: stale Pod HRV/RHR (not from today) is suppressed', () => {
  // 20 days of HRV ending well in the past, with a final low spike — would flag,
  // but since the latest reading predates "today" it's a stale Pod read → no anomaly.
  const hrv = mkSeries(20, (i) => (i === 19 ? 24 : 45 + ((i % 3) - 1) * 2), '2026-05-01T12:00:00');
  const stale = a.computeAnomalies({ 'health:hrv': hrv });
  assert.equal(stale.find((f) => f.evidence.metric === 'health:hrv'), undefined, 'stale HRV must not raise an anomaly');
  // With today injected as the reading's own day, the same series DOES flag — proving
  // it's the staleness gate (not the data) doing the suppression.
  const fresh = a.computeAnomalies({ 'health:hrv': hrv }, { today: '2026-05-20' });
  assert.ok(fresh.find((f) => f.evidence.metric === 'health:hrv'), 'a same-day reading should still flag');
});

test('computeHabitHealthSplits: mood is a first-class outcome of habits', () => {
  const N = 42;
  // Meditation on even days; mood clearly (and consistently) higher those days.
  const tm = mkSeries(N, (i) => (i % 2 === 0 ? 1 : 0));
  const mood = mkSeries(N, (i) => (i % 2 === 0 ? 4.4 : 3.2) + (i % 5) * 0.05);
  const findings = a.computeHabitHealthSplits({
    'habits:morning_tm': tm,
    'wellbeing:mood': mood,
  });
  const f = findings.find((x) => x.evidence.outcome === 'wellbeing:mood');
  assert.ok(f, 'expected a mood habit-split finding');
  assert.equal(f.type, 'habit_split');
  assert.ok(f.domains.includes('wellbeing'), 'mood finding should be tagged wellbeing, not health');
  assert.match(f.title, /\/5/, 'mood values should render on the /5 scale');
  assert.ok(f.evidence.onMean > f.evidence.offMean, 'meditation days should show higher mood');
  assert.ok(f.evidence.p < 0.05, 'must pass the significance gate');
});

test('computeHabitHealthSplits: noisy overlapping mood must not produce a finding', () => {
  const N = 42;
  const tm = mkSeries(N, (i) => (i % 2 === 0 ? 1 : 0));
  // Mood varies 3..5 with no relationship to the habit.
  const mood = mkSeries(N, (i) => 3 + ((i * 7) % 5) * 0.5);
  const findings = a.computeHabitHealthSplits({
    'habits:morning_tm': tm,
    'wellbeing:mood': mood,
  });
  assert.equal(findings.find((x) => x.evidence.outcome === 'wellbeing:mood'), undefined);
});

test('computeTrends: one anomalous week cannot become the baseline (vacation lapping)', () => {
  // 28 normal days ~12k steps, then a 7-day hiking-vacation week ~20k, then a
  // normal week ~12k. Week-vs-week math screams "steps down 38% (worsening)"
  // the moment normal life resumes; the 28d-median baseline sees a normal week
  // against a normal norm and stays quiet.
  const N = 42;
  const steps = mkSeries(N, (i) => {
    if (i >= 28 && i < 35) return 20000 + (i % 3) * 300; // vacation week
    return 12000 + (i % 5) * 200;                        // normal life
  });
  const findings = a.computeTrends({ 'health:steps': steps });
  assert.equal(findings.find((f) => f.evidence.metric === 'health:steps'), undefined,
    'returning to normal after a vacation week must not read as a steps crash');
});

test('computeTrends: a genuine sustained decline still fires against the 28d norm', () => {
  // Four normal weeks ~12k, then a real slump week ~8k (-33% vs norm).
  const N = 42;
  const steps = mkSeries(N, (i) => (i >= 35 ? 8000 + (i % 3) * 150 : 12000 + (i % 5) * 200));
  const f = a.computeTrends({ 'health:steps': steps }).find((x) => x.evidence.metric === 'health:steps');
  assert.ok(f, 'a real decline vs the personal norm must still surface');
  assert.match(f.title, /vs your 28d norm/);
});

test('computeTrends: a frozen night-sourced series (Eight Sleep not in use) does not keep reporting a stale trend', () => {
  // 42 nights of deep sleep ending well in the past, with a genuine +20%-ish
  // recent-vs-prior split — exactly the shape that would otherwise regenerate
  // "Deep sleep up +20% vs your 28d norm (improving)" every run even though no
  // new night has landed in a week.
  const N = 42;
  const deepSleep = mkSeries(N, (i) => (i >= 35 ? 1.8 : 1.2), '2026-05-01T12:00:00');
  const stale = a.computeTrends({ 'health:deep_sleep_hours': deepSleep });
  assert.equal(
    stale.find((f) => f.evidence.metric === 'health:deep_sleep_hours'), undefined,
    'a night metric frozen for days must not keep regenerating the same trend as current'
  );
  // Same series, "today" pinned to its own last night → genuinely fresh, fires normally.
  const lastDay = deepSleep[deepSleep.length - 1].day;
  const fresh = a.computeTrends({ 'health:deep_sleep_hours': deepSleep }, { today: lastDay });
  assert.ok(
    fresh.find((f) => f.evidence.metric === 'health:deep_sleep_hours'),
    'the identical data, when actually current, should still surface a real trend'
  );
});

test('computeAnomalies: stale-Pod suppression covers sleep metrics too, not just HRV/RHR', () => {
  // Same shape as the existing HRV staleness test, but for a metric the old
  // NIGHT_LOCKED set didn't cover — deep sleep should be suppressed the same way.
  const deepSleep = mkSeries(20, (i) => (i === 19 ? 0.3 : 1.5 + ((i % 3) - 1) * 0.1), '2026-05-01T12:00:00');
  const stale = a.computeAnomalies({ 'health:deep_sleep_hours': deepSleep });
  assert.equal(
    stale.find((f) => f.evidence.metric === 'health:deep_sleep_hours'), undefined,
    'stale deep-sleep reading must not raise an anomaly'
  );
  const fresh = a.computeAnomalies({ 'health:deep_sleep_hours': deepSleep }, { today: '2026-05-20' });
  assert.ok(fresh.find((f) => f.evidence.metric === 'health:deep_sleep_hours'), 'a same-day reading should still flag');
});

test('computeCorrelations: a frozen night-sourced metric (Eight Sleep not in use) stops pairing into new correlations', () => {
  // A perfectly linear HRV/mood pair — clears every gate (n, |r|, confirmed,
  // FDR) with room to spare — so if it's missing, staleness is what did it.
  const N = 30;
  const hrv = mkSeries(N, (i) => 40 + i);
  const mood = mkSeries(N, (i) => 2 + i * 0.2);
  const stale = a.computeCorrelations({ 'health:hrv': hrv, 'wellbeing:mood': mood });
  assert.equal(
    stale.find((f) => f.evidence.a === 'health:hrv' || f.evidence.b === 'health:hrv'), undefined,
    'a stale night-sourced metric must not surface in a new correlation — otherwise leverage/PERSISTENT ISSUES ' +
    'keep citing a frozen HRV pattern as if it were still being tracked'
  );
  // Same series, "today" pinned to the series' own last day → genuinely fresh.
  const lastDay = hrv[hrv.length - 1].day;
  const fresh = a.computeCorrelations({ 'health:hrv': hrv, 'wellbeing:mood': mood }, { today: lastDay });
  assert.ok(
    fresh.find((f) => f.evidence.a === 'health:hrv' || f.evidence.b === 'health:hrv'),
    'the identical data, when actually current, should still surface the correlation'
  );
});

// ── lifeContextRelevant: a life annotation must plausibly explain the SPECIFIC
// metric it's attached to, not just have happened around the same time ───────

test('lifeContextRelevant: a sleep/travel annotation explains body metrics regardless of wording', () => {
  const ann = { label: "Didn't sleep home", note: null };
  for (const metric of ['health:hrv', 'health:resting_hr', 'health:sleep_hours', 'health:sleep_score', 'health:respiratory_rate']) {
    assert.equal(a.lifeContextRelevant(metric, ann), true, `${metric} should accept broad life context`);
  }
});

test('lifeContextRelevant: the same sleep/travel annotation does NOT explain mood without an emotional link', () => {
  const ann = { label: "Didn't sleep home", note: null };
  for (const metric of ['wellbeing:mood', 'wellbeing:energy', 'wellbeing:focus']) {
    assert.equal(a.lifeContextRelevant(metric, ann), false, `${metric} should reject a non-emotional annotation`);
  }
});

test('lifeContextRelevant: an emotionally significant annotation DOES explain a wellbeing dip', () => {
  const ann = { label: 'Stressful launch at work, big deadline', note: null };
  assert.equal(a.lifeContextRelevant('wellbeing:mood', ann), true);
  assert.equal(a.lifeContextRelevant('wellbeing:energy', ann), true);
  assert.equal(a.lifeContextRelevant('wellbeing:focus', ann), true);
});

test('lifeContextRelevant: no life context explains an unrelated metric like steps', () => {
  assert.equal(a.lifeContextRelevant('health:steps', { label: 'Stressful day', note: null }), false);
});

test('lifeContextRelevant: checks the note field too, not just the label', () => {
  const ann = { label: 'Q: how are you?', note: 'Answer: felt really anxious all day' };
  assert.equal(a.lifeContextRelevant('wellbeing:mood', ann), true);
});

// Regression: the MOOD_KEYWORDS regex must not fire on common words that merely
// CONTAIN an emotional root — "chill"/"skill"/"still"/"bill" (ill), "floss"/
// "gloss" (loss). A casual "chill day" note is not an emotional explanation for
// a mood dip; matching it re-introduces the exact proximity-not-reasoning bug
// this whole function was written to kill.
test('lifeContextRelevant: casual notes containing an emotional substring do NOT explain a wellbeing dip', () => {
  for (const label of ['Chill day at home', 'Worked on a new skill', 'Paid the bill', 'Still catching up', 'Flossed and brushed', 'Went for a hill climb']) {
    assert.equal(a.lifeContextRelevant('wellbeing:mood', { label, note: null }), false, `"${label}" must not count as emotional context`);
  }
});

// ...but the standalone words and their inflections still must.
test('lifeContextRelevant: standalone illness/loss/sadness still explain a wellbeing dip', () => {
  for (const label of ['Felt ill all day', 'Battling an illness', 'Dealing with a loss', 'Overwhelmed and sad', 'Real sadness today']) {
    assert.equal(a.lifeContextRelevant('wellbeing:mood', { label, note: null }), true, `"${label}" should count as emotional context`);
  }
});
