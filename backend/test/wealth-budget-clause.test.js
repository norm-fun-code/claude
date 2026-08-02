// Spending-trend cards ("X trending N% above your usual") must ALSO read against
// the Monarch budget when one exists — a trend the user can't map onto a budget
// is only half the story. These tests stub the data layer and assert the budget
// clause is (and isn't) appended in each case.
const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the singleton modules BEFORE requiring wealth-insights (CommonJS caches
// the same object, so overwriting methods here reaches the code under test).
const documents = require('../src/store/documents');
const metricsStore = require('../src/store/metrics');
const monarchWealth = require('../src/services/monarch-wealth');

// Fixed mid-month instant (day 15) — buildWealthInsights's degraded fallback
// path deliberately suppresses ALL spike cards during the first 6 days of a
// real calendar month (a 1-2 day run-rate projection is too noisy to trust:
// day 2 of a 31-day month projects a 15.5x run-rate off a single purchase —
// see wealth-insights.js's projectionReliable). Pinning `now` keeps these
// tests exercising the "reliable" branch regardless of which day this suite
// actually runs on, instead of going spuriously red for the first week of
// every real calendar month (the exact failure this fixes).
const NOW = new Date('2026-07-15T16:00:00Z');
function currentMonth(d = NOW) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthsBack(n, d = NOW) {
  const x = new Date(d.getFullYear(), d.getMonth() - n, 1);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
}

// A clear Taxi spike: ~$186 avg over three prior months, $442 so far this month.
function taxiRows() {
  return [
    { month: monthsBack(3), category: 'Taxi & Ride Shares', spend: 180 },
    { month: monthsBack(2), category: 'Taxi & Ride Shares', spend: 190 },
    { month: monthsBack(1), category: 'Taxi & Ride Shares', spend: 188 },
    { month: currentMonth(), category: 'Taxi & Ride Shares', spend: 442 },
  ];
}

function stub({ pacingLines }) {
  documents.monthlyCategorySpend = async () => taxiRows();
  documents.spendTransactions = async () => [];
  metricsStore.dailyAggregate = async () => []; // no income/net-worth signal
  monarchWealth.getRecurring = async () => null;
  monarchWealth.getInvestments = async () => null;
  monarchWealth.getBudgetPacing = async () => ({
    asOf: new Date().toISOString(),
    dayOfMonth: 8,
    daysInMonth: 31,
    elapsed: 8 / 31,
    lines: pacingLines,
    totals: null,
  });
}

// Load the module under test AFTER the singletons exist (methods are swapped per
// test below, so a single require is fine — calls read the current method).
const { buildWealthInsights } = require('../src/services/wealth-insights');

test('trend card gains a budget clause when under-budget but pacing over', async () => {
  stub({
    pacingLines: [
      // pace 1.2 (>1.05, <1.3) → no dedicated over-budget card, so the trend card
      // survives AND should carry the budget read.
      { category: 'Taxi & Ride Shares', budget: 2000, actual: 442, remaining: 1558, pace: 1.2, overBudget: false },
    ],
  });
  const insights = await buildWealthInsights({ now: NOW });
  const trend = insights.find((i) => i.type === 'spending_pattern' && i.category === 'Taxi & Ride Shares');
  assert.ok(trend, 'expected a spending_pattern card for Taxi & Ride Shares');
  // wealth-insights.js picks between two vs-usual phrasings ("so far this
  // month — on pace for... above" vs "this month — about N% more than")
  // depending on how far the real calendar day is into the month (the
  // run-rate projection factor) — not something this test stubs, so assert
  // on whichever phrasing is live rather than pinning one and going flaky
  // across the month boundary.
  assert.match(trend.detail, /(?:above|more than) your recent average/, 'keeps the vs-usual read');
  assert.match(trend.detail, /\$2,000 budget/, 'adds the budget figure');
  assert.match(trend.detail, /on pace to finish about 20% over/, 'states budget pace');
});

test('trend card notes when the trend is still within budget', async () => {
  stub({
    pacingLines: [
      { category: 'Taxi & Ride Shares', budget: 5000, actual: 442, remaining: 4558, pace: 0.9, overBudget: false },
    ],
  });
  const insights = await buildWealthInsights({ now: NOW });
  const trend = insights.find((i) => i.type === 'spending_pattern' && i.category === 'Taxi & Ride Shares');
  assert.ok(trend);
  assert.match(trend.detail, /within your \$5,000 budget/, 'reassures it is inside budget');
});

test('trend card has no budget clause when the category has no budget', async () => {
  stub({ pacingLines: [] }); // Monarch has no budget for this category
  const insights = await buildWealthInsights({ now: NOW });
  const trend = insights.find((i) => i.type === 'spending_pattern' && i.category === 'Taxi & Ride Shares');
  assert.ok(trend);
  assert.doesNotMatch(trend.detail, /budget/, 'no budget mention when none exists');
});

test('over-budget category shows the dedicated over_budget card, not a duplicate trend', async () => {
  stub({
    pacingLines: [
      { category: 'Taxi & Ride Shares', budget: 300, actual: 442, remaining: -142, pace: 5.7, overBudget: true },
    ],
  });
  const insights = await buildWealthInsights({ now: NOW });
  const over = insights.find((i) => i.type === 'over_budget' && i.category === 'Taxi & Ride Shares');
  const trend = insights.find((i) => i.type === 'spending_pattern' && i.category === 'Taxi & Ride Shares');
  assert.ok(over, 'expected an over_budget card');
  assert.equal(trend, undefined, 'trend card deduped away in favor of the authoritative over_budget card');
});
