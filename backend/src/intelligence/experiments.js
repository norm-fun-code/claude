// The hypothesis loop — NormOS as a personal data scientist.
//
// Correlation finds candidates; experiments find truth. Unconfirmed
// lever↔outcome correlations become proposed experiments; once run, NormOS
// compares the outcome during the test window to the baseline and issues a
// verdict (confirmed / refuted / inconclusive).
require('dotenv').config();
const stats = require('./stats');
const cat = require('./catalog');
const { LEVERS, OUTCOMES } = require('./leverage');

const DEFAULTS = { baselineDays: 14, testDays: 14, minN: 4, minEffect: 0.3, minPct: 0.03 };

function splitKey(key) {
  const i = key.indexOf(':');
  return { domain: key.slice(0, i), metric: key.slice(i + 1) };
}

/** Pure: verdict from baseline vs test samples given the expected direction. */
function verdict(baselineValues, testValues, expected = 'up', opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const b = baselineValues.filter(Number.isFinite);
  const t = testValues.filter(Number.isFinite);
  if (b.length < o.minN || t.length < o.minN) {
    return { verdict: 'inconclusive', reason: 'insufficient data', n: { baseline: b.length, test: t.length } };
  }

  const baselineMean = stats.mean(b);
  const testMean = stats.mean(t);
  const delta = testMean - baselineMean;
  const sb = stats.std(b) ?? 0;
  const st = stats.std(t) ?? 0;
  const pooled = Math.sqrt((sb * sb + st * st) / 2) || 1e-9;
  const effectSize = delta / pooled; // Cohen's d
  const expectedSign = expected === 'down' ? -1 : 1;
  const pctChange = baselineMean !== 0 ? delta / Math.abs(baselineMean) : null;

  // Require both a real effect size AND a non-trivial percent change, so a tiny
  // absolute shift with low variance doesn't get called a result.
  let v = 'inconclusive';
  const bigEnough =
    Math.abs(effectSize) >= o.minEffect && (pctChange == null || Math.abs(pctChange) >= o.minPct);
  if (bigEnough) {
    v = Math.sign(delta) === expectedSign ? 'confirmed' : 'refuted';
  }

  return {
    verdict: v,
    baselineMean: round(baselineMean),
    testMean: round(testMean),
    delta: round(delta),
    pctChange: pctChange == null ? null : round(pctChange, 3),
    effectSize: round(effectSize, 2),
    n: { baseline: b.length, test: t.length },
  };
}

function round(n, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// Levers that make sense as experiment interventions: things the user has direct
// daily agency over. Excludes abstract quantitative metrics (active_energy,
// exercise_minutes, steps as raw numbers) — those are outcomes of habits, not
// the thing you set out to change. Habit levers are what you commit to for 14 days.
const EXPERIMENT_LEVERS = new Set([
  'habits:cold_shower',
  'habits:morning_tm',
  'habits:afternoon_tm',
  'habits:gratitude',
  'habits:exercise',
  'habits:eat_healthy',
  'health:sleep_hours',
  'health:mindful_minutes',
  'productivity:meetings',
]);

/** Pure: turn unconfirmed lever↔outcome correlations into experiment specs.
 *  Quality gates: minimum |r|, minimum n, and lever must be directly actionable. */
function proposeFromFindings(findings = [], opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const MIN_R = 0.45;  // require meaningful effect size before proposing an experiment
  const MIN_N = 14;    // need at least 2 weeks of data points to be worth testing

  const proposals = [];

  for (const f of findings) {
    const ev = f.evidence || {};
    if (ev.kind !== 'correlation' || ev.confirmed !== false) continue;
    // Only propose experiments for meaningful correlations with enough data.
    if (ev.r == null || Math.abs(ev.r) < MIN_R) continue;
    if (ev.n == null || ev.n < MIN_N) continue;

    let lever, outcome;
    if (EXPERIMENT_LEVERS.has(ev.a) && OUTCOMES.has(ev.b)) [lever, outcome] = [ev.a, ev.b];
    else if (EXPERIMENT_LEVERS.has(ev.b) && OUTCOMES.has(ev.a)) [lever, outcome] = [ev.b, ev.a];
    else continue;

    const lv = splitKey(lever);
    const ov = splitKey(outcome);
    const leverLabel = cat.label(lv.domain, lv.metric);
    const outcomeLabel = cat.label(ov.domain, ov.metric);
    const wantOutcomeUp = cat.goodWhen(ov.domain, ov.metric) !== 'down';
    const moreIsBetter = (ev.r >= 0) === wantOutcomeUp;
    const phrase = LEVERS[lever]?.[moreIsBetter ? 'more' : 'less'] ?? (moreIsBetter ? `more ${leverLabel.toLowerCase()}` : `less ${leverLabel.toLowerCase()}`);
    const lagNote = ev.lag ? ` (effect expected ~${ev.lag} day${ev.lag !== 1 ? 's' : ''} after)` : '';

    proposals.push({
      hypothesis: `${moreIsBetter ? 'Increasing' : 'Reducing'} ${leverLabel} improves ${outcomeLabel}`,
      metric: outcome,
      lever,
      expected: wantOutcomeUp ? 'up' : 'down',
      protocol: `For ${o.testDays} days, ${phrase}. NormOS will compare ${outcomeLabel} to your prior ${o.baselineDays}-day baseline${lagNote}.`,
      baselineDays: o.baselineDays,
      status: 'proposed',
      sourceFinding: f.id ?? null,
    });
  }

  return proposals;
}

// --- DB orchestration ------------------------------------------------------

async function proposeExperiments() {
  const findingsStore = require('../store/findings');
  const experimentsStore = require('../store/experiments');
  // Cancel any previously-created experiments whose outcome is in the wealth
  // domain — wealth correlations are lifestyle confounds, not actionable levers.
  await experimentsStore.cancelExperimentsByMetricDomain('wealth').catch(() => {});
  const open = await findingsStore.listFindings({ status: 'open' });
  const proposals = proposeFromFindings(open);
  let created = 0;
  for (const p of proposals) {
    const id = await experimentsStore.createExperiment(p);
    if (id) created++;
  }
  return { proposed: proposals.length, created };
}

/**
 * Auto-start the highest-priority proposed experiment that isn't already
 * running for the same metric. Called after proposeExperiments() so the loop
 * is self-sustaining: correlations → proposals → running → verdicts → briefing.
 * Starts at most one new experiment per call to avoid overwhelming the user.
 */
async function autoStartExperiment() {
  const experimentsStore = require('../store/experiments');
  const all = await experimentsStore.listExperiments();
  const running = all.filter((e) => e.status === 'running');
  const runningMetrics = new Set(running.map((e) => e.metric));

  // Skip auto-start if already running 2+ experiments — avoid overload.
  if (running.length >= 2) return null;

  const proposed = all.filter((e) => e.status === 'proposed' && !runningMetrics.has(e.metric));
  if (!proposed.length) return null;

  // Pick the first proposal (listExperiments returns created_at DESC).
  const pick = proposed[0];
  const startDate = new Date().toISOString().slice(0, 10);
  const endDate = new Date(Date.now() + (pick.baseline_days || 14) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  await experimentsStore.updateExperiment(pick.id, {
    status: 'running',
    startDate,
    endDate,
  });

  console.log(`[experiments] auto-started: "${pick.hypothesis}" (ends ${endDate})`);
  return { id: pick.id, hypothesis: pick.hypothesis, startDate, endDate };
}

/** Evaluate one running experiment against its baseline + test windows. */
async function evaluateExperiment(exp) {
  const metricsStore = require('../store/metrics');
  const experimentsStore = require('../store/experiments');
  const { domain, metric } = splitKey(exp.metric);

  const start = new Date(exp.start_date);
  const end = exp.end_date ? new Date(exp.end_date) : new Date();
  const baselineStart = new Date(start);
  baselineStart.setDate(baselineStart.getDate() - (exp.baseline_days || 14));

  const baseline = await metricsStore.dailyAggregate({
    domain, metric, from: baselineStart, to: start, agg: cat.aggFor(metric), excludeSource: 'seed',
  });
  const test = await metricsStore.dailyAggregate({
    domain, metric, from: start, to: end, agg: cat.aggFor(metric), excludeSource: 'seed',
  });

  const result = verdict(
    baseline.map((r) => Number(r.value)),
    test.map((r) => Number(r.value)),
    exp.expected
  );

  await experimentsStore.updateExperiment(exp.id, {
    status: 'completed',
    verdict: result.verdict,
    result,
  });
  return { id: exp.id, ...result };
}

/** Evaluate all running experiments whose end date has passed. */
async function evaluateDue() {
  const experimentsStore = require('../store/experiments');
  const running = await experimentsStore.listExperiments({ status: 'running' });
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (const exp of running) {
    if (exp.end_date && exp.end_date.toISOString?.().slice(0, 10) <= today) {
      out.push(await evaluateExperiment(exp));
    } else if (typeof exp.end_date === 'string' && exp.end_date <= today) {
      out.push(await evaluateExperiment(exp));
    }
  }
  return out;
}

module.exports = { verdict, proposeFromFindings, proposeExperiments, autoStartExperiment, evaluateExperiment, evaluateDue, DEFAULTS };
