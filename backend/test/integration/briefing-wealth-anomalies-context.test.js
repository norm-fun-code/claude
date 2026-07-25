// Live bug found via a product screenshot review: the Chief Brief said "no
// unusual spike" in spending while the SAME briefing's Wealth tab showed 3
// flagged category anomalies — because the chief-brief's spendingContext was
// built from its own separate, narrower "yesterday's total spend vs a 31-day
// daily average" check, completely independent of buildWealthInsights() (the
// function that actually powers the Wealth tab's "What The Data Shows"
// card). Two detectors, one true state of the world, and they disagreed.
//
// spendingContext is now built FROM buildWealthInsights()'s own
// spending_pattern/over_budget findings, ranked by dollar impact (not raw
// percentage — a $400/400% spike on a small category isn't more real than a
// $600/60% spike on a big one). This test seeds category-spend and
// budget-pacing data that produces anomalies where the dollar ranking and
// the percentage ranking DISAGREE, and confirms the chief-brief prompt gets
// the same anomalies, in the same (dollar) order, that the Wealth tab would
// show — capped at the top 3.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const documents = require('../../src/store/documents');
const metricsStore = require('../../src/store/metrics');
const monarchWealth = require('../../src/services/monarch-wealth');

const app = buildTestApp();
// Long enough to clear assessChiefBriefQuality's minimum-completeness bar
// (synthesis >= 12 words) — a bare marker phrase would silently degrade and
// fail the exact-equality assertions below (audit fix, item B).
const MARKER = `Wealth anomalies context regression marker with plenty of extra descriptive words today ${Date.now()}`;
const FULL_ACTION = 'Review the top spending anomalies before they compound further this month.';
const FULL_RISK = 'Overspending in these categories could crowd out this quarter\'s savings goal.';
const FULL_MOVE = 'Set a reminder to check category budgets again at the next pay cycle.';
const FULL_MORNING_FOCUS = 'Take a few minutes today to review where spending has quietly drifted away from the original plan.';

function monthsBack(n, d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth() - n, 1);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
}

async function seedPriorBriefing() {
  const content = {
    day: new Date().toISOString().slice(0, 10),
    chiefBrief: { synthesis: 'prior', action: 'a', risk: 'r', move: 'm', openQuestion: '' },
    morningFocus: 'prior focus',
    urgentEmails: [],
  };
  await db.query(`INSERT INTO briefings (kind, content) VALUES ('daily', $1)`, [JSON.stringify(content)]);
}

after(async () => {
  await db.query(`DELETE FROM briefings WHERE content->>'day' = $1 AND content->'chiefBrief'->>'synthesis' = 'prior'`, []).catch(() => {});
  await closeDb();
});

test('chief-brief spendingContext is built from buildWealthInsights(), ranked by dollar impact across spending_pattern + over_budget, capped at 3', async (t) => {
  await seedPriorBriefing();

  // "current" is a PAST month (not the real current month), so projFactor is
  // always 1 regardless of what day-of-month this test happens to run on —
  // deterministic across CI runs.
  const current = monthsBack(1);
  const priors = [monthsBack(4), monthsBack(3), monthsBack(2)];

  documents.monthlyCategorySpend = async () => {
    const rows = [];
    // Restaurants: $1000 avg -> $1600 this "current" month = $600 overage, 60%.
    for (const m of priors) rows.push({ month: m, category: 'Restaurants', spend: 1000 });
    rows.push({ month: current, category: 'Restaurants', spend: 1600 });
    // Clothing: $100 avg -> $500 = $400 overage, but a much louder 400%.
    for (const m of priors) rows.push({ month: m, category: 'Clothing', spend: 100 });
    rows.push({ month: current, category: 'Clothing', spend: 500 });
    // Groceries: $500 avg -> $650 = $150 overage — qualifies as a spike but
    // must be pushed out of the top 3 by the larger anomalies below.
    for (const m of priors) rows.push({ month: m, category: 'Groceries', spend: 500 });
    rows.push({ month: current, category: 'Groceries', spend: 650 });
    return rows;
  };
  documents.spendTransactions = async () => [];
  metricsStore.dailyAggregate = async () => [];
  monarchWealth.getRecurring = async () => null;
  monarchWealth.getInvestments = async () => null;
  monarchWealth.getBudgetPacing = async () => ({
    asOf: new Date().toISOString(),
    dayOfMonth: 15,
    daysInMonth: 30,
    elapsed: 0.5,
    // Entertainment: $800 over budget — the single biggest dollar anomaly,
    // bigger than either spending_pattern spike above.
    lines: [{ category: 'Entertainment', budget: 1000, actual: 1800, remaining: -800, pace: 1.8, overBudget: true }],
    totals: null,
  });

  let capturedPrompt = null;
  const originalGenerateText = llm.generateText;
  t.after(() => {
    llm.generateText = originalGenerateText;
    delete documents.monthlyCategorySpend;
    delete documents.spendTransactions;
    delete metricsStore.dailyAggregate;
    delete monarchWealth.getRecurring;
    delete monarchWealth.getInvestments;
    delete monarchWealth.getBudgetPacing;
  });
  llm.generateText = async ({ system, prompt }) => {
    if (system.includes('chief of staff and data scientist')) {
      capturedPrompt = prompt;
      // The chief-brief call requests returnMeta:true (safe-to-log metadata
      // alongside the text — see briefing-ai.js) — a bare string here would
      // break chiefBriefAttempt's destructuring.
      return {
        text: JSON.stringify({
          chiefBrief: { synthesis: MARKER, action: FULL_ACTION, risk: FULL_RISK, move: FULL_MOVE, openQuestion: '' },
          morningFocus: FULL_MORNING_FOCUS,
        }),
        stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
      };
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };

  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.chiefBrief?.synthesis, MARKER, 'confirms this went through the real fresh-build path');
  assert.ok(capturedPrompt, 'expected the chief-brief LLM call to have fired');

  assert.match(
    capturedPrompt,
    /Spending signal: Spending patterns this month \(ranked by dollar impact\):/,
    'spendingContext must now be sourced from wealth-insights, not the old day-level check'
  );
  // Same anomalies the Wealth tab's "What The Data Shows" card would surface
  // (buildWealthInsights' own titles), in dollar-descending order: $800
  // (Entertainment over_budget) > $600 (Restaurants, 60%) > $400 (Clothing,
  // 400% — louder percentage, smaller dollar impact, correctly ranked last).
  const entIdx = capturedPrompt.indexOf('Entertainment: over budget ($1,800 of $1,000)');
  const restIdx = capturedPrompt.indexOf('Restaurants trending 60% above your usual');
  const clothIdx = capturedPrompt.indexOf('Clothing trending 400% above your usual');
  assert.ok(entIdx !== -1, `expected Entertainment over-budget line in prompt spendingContext; got: ${capturedPrompt.match(/Spending signal:[^\n]*/)}`);
  assert.ok(restIdx !== -1, 'expected Restaurants trend line in prompt spendingContext');
  assert.ok(clothIdx !== -1, 'expected Clothing trend line in prompt spendingContext');
  assert.ok(entIdx < restIdx && restIdx < clothIdx, 'must be ranked by dollar impact ($800 > $600 > $400), not by percentage (400% > 60%)');

  assert.doesNotMatch(
    capturedPrompt,
    /Groceries/,
    'the 4th-largest anomaly ($150) must be excluded — spendingContext caps at the top 3 by dollar impact'
  );
  assert.doesNotMatch(
    capturedPrompt,
    /Discretionary spending yesterday was/,
    'the old independent day-level spend-vs-baseline check must no longer be the source of spendingContext'
  );
});

// Regression guard: restructuring spendingContext's source (above) initially
// deleted the recentSpend/spendBaseline computation but left a downstream
// preBriefSignals.buildSignals({ spend: recentSpend, spendBaseline, ... })
// call referencing them — a ReferenceError that silently killed the ENTIRE
// pre-brief-signals try block (caught and logged, never surfaced), including
// the unrelated tomorrow's-calendar and spending-spike proactive questions.
// This confirms that day-granularity "anything to explain that spend?"
// question — a distinct signal from spendingContext's month-granularity
// category narrative — still fires end-to-end through a real briefing build.
test('the day-level "anything to explain that spend?" pre-brief question still fires (regression guard for the recentSpend ReferenceError)', async (t) => {
  await seedPriorBriefing();

  documents.monthlyCategorySpend = async () => [];
  documents.spendTransactions = async () => [];
  monarchWealth.getRecurring = async () => null;
  monarchWealth.getInvestments = async () => null;
  monarchWealth.getBudgetPacing = async () => ({ asOf: new Date().toISOString(), dayOfMonth: 15, daysInMonth: 30, elapsed: 0.5, lines: [], totals: null });
  metricsStore.dailyAggregate = async ({ metric, from, to }) => {
    if (metric !== 'spending_discretionary') return [];
    const spanDays = (new Date(to) - new Date(from)) / 86400000;
    // The ~1-day "yesterday" window: a $500 spike.
    if (spanDays <= 2) return [{ day: 'yesterday', value: 500 }];
    // The ~31-day baseline window: a $50/day average (need >=7 rows to count).
    return Array.from({ length: 30 }, (_, i) => ({ day: `d${i}`, value: 50 }));
  };

  const originalGenerateText = llm.generateText;
  t.after(() => {
    llm.generateText = originalGenerateText;
    delete documents.monthlyCategorySpend;
    delete documents.spendTransactions;
    delete metricsStore.dailyAggregate;
    delete monarchWealth.getRecurring;
    delete monarchWealth.getInvestments;
    delete monarchWealth.getBudgetPacing;
  });
  llm.generateText = async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) {
      return {
        text: JSON.stringify({
          chiefBrief: { synthesis: `${MARKER} 2`, action: FULL_ACTION, risk: FULL_RISK, move: FULL_MOVE, openQuestion: '' },
          morningFocus: FULL_MORNING_FOCUS,
        }),
        stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
      };
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };

  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.chiefBrief?.synthesis, `${MARKER} 2`);
  assert.ok(Array.isArray(res.body.signals), 'expected a signals array in the response');
  const spike = res.body.signals.find((s) => s.key === 'spending_spike');
  assert.ok(spike, `expected a spending_spike pre-brief question; got signals: ${JSON.stringify(res.body.signals)}`);
  assert.match(spike.question, /\$500 in discretionary yesterday/);
});
