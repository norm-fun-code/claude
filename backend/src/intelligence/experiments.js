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

const DEFAULTS = { baselineDays: 14, testDays: 14, minN: 4, minEffect: 0.3, minPct: 0.03, alpha: 0.05 };

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

  // Welch two-sample test of test-window vs baseline-window. This is the "find
  // truth" step, so it must be the MOST rigorous part of the pipeline — a verdict
  // of "confirmed" needs the difference to be statistically distinguishable from
  // noise (a real p-value), not merely a large Cohen's d on a handful of days.
  const w = stats.welchTTest(b, t); // diff = test − baseline
  if (!w) {
    return { verdict: 'inconclusive', reason: 'insufficient variance/data', n: { baseline: b.length, test: t.length } };
  }
  const baselineMean = w.meanA;
  const testMean = w.meanB;
  const delta = w.diff;
  const effectSize = w.cohenD; // Cohen's d (pooled SD)
  const expectedSign = expected === 'down' ? -1 : 1;
  const pctChange = baselineMean !== 0 ? delta / Math.abs(baselineMean) : null;

  // A result must clear THREE bars: statistical significance (p ≤ alpha), a real
  // effect size, and a non-trivial percent change. Anything short of all three is
  // "inconclusive" — we don't call noise a discovery, and we don't over-call a
  // tiny-but-tight shift. Direction then decides confirmed vs refuted.
  let v = 'inconclusive';
  const significant = w.p != null && w.p <= o.alpha;
  const bigEnough =
    Math.abs(effectSize) >= o.minEffect && (pctChange == null || Math.abs(pctChange) >= o.minPct);
  if (significant && bigEnough) {
    v = Math.sign(delta) === expectedSign ? 'confirmed' : 'refuted';
  }

  return {
    verdict: v,
    baselineMean: round(baselineMean),
    testMean: round(testMean),
    delta: round(delta),
    pctChange: pctChange == null ? null : round(pctChange, 3),
    effectSize: round(effectSize, 2),
    p: w.p == null ? null : round(w.p, 4),
    ci: [round(w.ciLow), round(w.ciHigh)],
    // Honest caveat for the user: an N-of-1 before/after comparison cannot rule
    // out regression to the mean or seasonality — a 14-day test is a strong hint,
    // not proof. Surfaced in the experiment card narrative.
    caveat: 'N-of-1 before/after — association, not proof; regression to the mean and seasonal effects are not controlled.',
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
  // Cancel ALL stale experiments before re-proposing. Quality gates in
  // proposeFromFindings (EXPERIMENT_LEVERS, MIN_R, MIN_N) ensure only meaningful
  // hypotheses come back. This prevents stale entries like "Steps improves Net worth"
  // from lingering indefinitely.
  await experimentsStore.cancelAllProposedExperiments().catch(() => {});
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
 * Auto-start the newest proposed experiment — OFF by default. Consent is the
 * EXPERIMENTS_AUTO_START=true env flag (an explicit owner decision, not a
 * silent default): with it unset, proposals surface in the Experiments card
 * and must be started by hand, exactly as before. With it set, the hypothesis
 * loop becomes self-sustaining: when nothing is running, the newest proposal
 * starts itself for the standard test window and a push tells the user what
 * began — pausing it in the app remains one tap, so consent stays visible and
 * revocable per-experiment.
 */
async function autoStartExperiment() {
  if (String(process.env.EXPERIMENTS_AUTO_START).toLowerCase() !== 'true') return null;
  const experimentsStore = require('../store/experiments');

  const running = await experimentsStore.listExperiments({ status: 'running' });
  if (running.length) return null; // one live experiment at a time — clean baselines
  const proposed = await experimentsStore.listExperiments({ status: 'proposed' });
  if (!proposed.length) return null;

  const exp = proposed[0]; // newest proposal (listExperiments orders created_at DESC)
  const start = new Date();
  const end = new Date();
  end.setDate(end.getDate() + DEFAULTS.testDays);
  await experimentsStore.updateExperiment(exp.id, {
    status: 'running',
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  });

  // Tell the user what just started — auto-start without a notification would
  // be a state change behind their back.
  try {
    const devicesStore = require('../store/devices');
    const { sendPush } = require('../notify/expo');
    const tokens = await devicesStore.listActiveTokens();
    if (tokens.length) {
      await sendPush(tokens, {
        title: 'Experiment started',
        body: `Auto-started a ${DEFAULTS.testDays}-day self-test: "${exp.hypothesis}". Pause it any time from the Experiments card.`,
        data: { key: `experiment_autostart:${exp.id}` },
      });
    }
  } catch (err) {
    console.error('[experiments] auto-start push failed:', err.message);
  }

  return { id: exp.id, hypothesis: exp.hypothesis };
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
