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

/** Pure: turn unconfirmed lever↔outcome correlations into experiment specs. */
function proposeFromFindings(findings = [], opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const proposals = [];

  for (const f of findings) {
    const ev = f.evidence || {};
    if (ev.kind !== 'correlation' || ev.confirmed !== false) continue;

    let lever, outcome;
    if (LEVERS[ev.a] && OUTCOMES.has(ev.b)) [lever, outcome] = [ev.a, ev.b];
    else if (LEVERS[ev.b] && OUTCOMES.has(ev.a)) [lever, outcome] = [ev.b, ev.a];
    else continue;

    const lv = splitKey(lever);
    const ov = splitKey(outcome);
    const leverLabel = cat.label(lv.domain, lv.metric);
    const outcomeLabel = cat.label(ov.domain, ov.metric);
    const moreIsBetter = ev.r >= 0;
    const phrase = LEVERS[lever][moreIsBetter ? 'more' : 'less'];

    proposals.push({
      hypothesis: `${moreIsBetter ? 'Increasing' : 'Reducing'} ${leverLabel} improves ${outcomeLabel}`,
      metric: outcome,
      lever,
      expected: 'up', // outcome should improve (rise on its "good" scale)
      protocol: `For ${o.testDays} days, ${phrase}. Then NormOS compares ${outcomeLabel} to your prior ${o.baselineDays}-day baseline.`,
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
  const open = await findingsStore.listFindings({ status: 'open' });
  const proposals = proposeFromFindings(open);
  let created = 0;
  for (const p of proposals) {
    const id = await experimentsStore.createExperiment(p);
    if (id) created++;
  }
  return { proposed: proposals.length, created };
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
    domain, metric, from: baselineStart, to: start, agg: cat.aggFor(metric),
  });
  const test = await metricsStore.dailyAggregate({
    domain, metric, from: start, to: end, agg: cat.aggFor(metric),
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

module.exports = { verdict, proposeFromFindings, proposeExperiments, evaluateExperiment, evaluateDue, DEFAULTS };
