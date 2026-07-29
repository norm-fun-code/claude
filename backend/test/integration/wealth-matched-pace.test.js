// Real-Postgres regression tests for the discretionary MTD matched-pace
// baseline (backend/src/services/wealth-pace.js) — coverage-tier safeguards,
// median-vs-outlier behavior, per-category drivers, DST-safe boundaries, and
// cross-surface identity between Wealth, BrainSnapshot, and Ask.
'use strict';
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const metricsStore = require('../../src/store/metrics');
const sourcesStore = require('../../src/store/sources');
const documentsStore = require('../../src/store/documents');
const { computeDiscretionaryMatchedPace, monthOffset, daysInMonth, matchedDayOfMonth } = require('../../src/services/wealth-pace');
const { buildWealthLandingProjection } = require('../../src/services/wealth-landing');
const { buildBrainSnapshot, canonicalFacts } = require('../../src/brain/snapshot');

const TZ = 'America/New_York';
const TAG = `wpace-${Date.now()}`;

after(async () => {
  await db.query(`DELETE FROM metrics WHERE source LIKE $1`, [`${TAG}%`]);
  await db.query(`DELETE FROM sources WHERE id LIKE $1`, [`${TAG}%`]);
  await db.query(`DELETE FROM documents WHERE source = 'monarch' AND external_id LIKE $1`, [`${TAG}%`]);
  await closeDb();
});

// asOf fixed at July 15, 2026 (EDT) — day 15 of a 31-day month, so
// elapsedDays=15, daysInCurrentMonth=31, giving predictable matched-day
// windows for every trailing month via the module's own pure helpers.
const ASOF = new Date('2026-07-15T16:00:00Z'); // 12:00 EDT (UTC-4) local
const ELAPSED_DAYS = 15;
const DAYS_IN_CURRENT = 31;

function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Seed `days` consecutive daily rows (day 1..days) of the day-keyed
 *  spending_discretionary metric for local month {y, m}, totaling exactly
 *  `totalAmount` (spread evenly) — "full coverage" for that window. */
async function seedAggregateMonth(source, y, m, days, totalAmount) {
  await sourcesStore.registerSource({ id: source, domain: 'wealth', displayName: `wealth-pace test (${source})` }).catch(() => {});
  const per = totalAmount / days;
  const rows = [];
  for (let day = 1; day <= days; day++) {
    rows.push({ ts: new Date(`${ymd(y, m, day)}T00:00:00Z`), domain: 'wealth', metric: 'spending_discretionary', value: per, source });
  }
  await metricsStore.insertMetrics(rows);
}

/** A single document (day 1 of {y, m}) carrying `amount` (negative = spend)
 *  under `category` — day 1 is always inside any matched window (matchedDay
 *  is always >= 1), so this is safe regardless of the exact matched-day math. */
async function seedCategoryDoc(externalId, y, m, category, amount) {
  await documentsStore.upsertDocument({
    source: 'monarch', domain: 'wealth', externalId, title: category, content: category,
    occurredAt: ymd(y, m, 1), metadata: { category, amount: String(amount), account: 'checking' },
  });
}

function targetForMonthsAgo(monthsAgo) {
  const target = monthOffset(2026, 7, monthsAgo);
  const targetDays = daysInMonth(target.y, target.m);
  const matchedDay = matchedDayOfMonth(ELAPSED_DAYS, DAYS_IN_CURRENT, targetDays);
  return { ...target, targetDays, matchedDay };
}

test('required: 6-12 eligible months -> "typical" pace, and the median resists a single outlier month (proving median, not mean)', async (t) => {
  const source = `${TAG}-typical`;
  t.after(async () => { await db.query(`DELETE FROM metrics WHERE source = $1`, [source]); });

  // Current month: $260 over the elapsed 15-day window.
  await seedAggregateMonth(source, 2026, 7, ELAPSED_DAYS, 260);
  // 5 trailing months at $200 each (full coverage), 1 trailing month (the
  // 6th) as a huge $10,000 outlier — still 6 eligible months -> "typical".
  for (let monthsAgo = 1; monthsAgo <= 5; monthsAgo++) {
    const { y, m, matchedDay } = targetForMonthsAgo(monthsAgo);
    await seedAggregateMonth(source, y, m, matchedDay, 200);
  }
  {
    const { y, m, matchedDay } = targetForMonthsAgo(6);
    await seedAggregateMonth(source, y, m, matchedDay, 10000);
  }
  // Months 7-12 deliberately left unseeded (zero rows -> ineligible, not $0).

  const pace = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ, monthsBack: 12 });
  assert.equal(pace.coverageTier, 'typical');
  assert.equal(pace.monthsUsed, 6, 'only the 6 fully-covered months count; the 6 unseeded months are gaps, not zeros');
  assert.equal(pace.medianBaseline, 200, 'median of [200,200,200,200,200,10000] is 200 — a mean would have been pulled to ~1750 by the outlier');
  assert.equal(pace.currentAmount, 260);
  assert.equal(pace.vsMedian.dollars, 60);
  assert.equal(pace.vsMedian.pct, 30);
  assert.equal(pace.paceLabel, 'above_typical');
  // Previous month (monthsAgo=1) was one of the $200 eligible months.
  assert.equal(pace.previousMonthAmount, 200);
  assert.equal(pace.vsPreviousMonth.dollars, 60);
});

test('required: 3-5 eligible months -> "recent" pace', async (t) => {
  const source = `${TAG}-recent`;
  t.after(async () => { await db.query(`DELETE FROM metrics WHERE source = $1`, [source]); });

  await seedAggregateMonth(source, 2026, 7, ELAPSED_DAYS, 150);
  for (let monthsAgo = 1; monthsAgo <= 4; monthsAgo++) {
    const { y, m, matchedDay } = targetForMonthsAgo(monthsAgo);
    await seedAggregateMonth(source, y, m, matchedDay, 150);
  }

  const pace = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ, monthsBack: 12 });
  assert.equal(pace.monthsUsed, 4);
  assert.equal(pace.coverageTier, 'recent');
  assert.ok(pace.medianBaseline != null, 'recent tier still produces a comparison, just labeled differently');
});

test('required: fewer than 3 eligible months -> the historical comparison is OMITTED, not invented', async (t) => {
  const source = `${TAG}-insufficient`;
  t.after(async () => { await db.query(`DELETE FROM metrics WHERE source = $1`, [source]); });

  await seedAggregateMonth(source, 2026, 7, ELAPSED_DAYS, 150);
  for (let monthsAgo = 1; monthsAgo <= 2; monthsAgo++) {
    const { y, m, matchedDay } = targetForMonthsAgo(monthsAgo);
    await seedAggregateMonth(source, y, m, matchedDay, 150);
  }

  const pace = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ, monthsBack: 12 });
  assert.equal(pace.monthsUsed, 2);
  assert.equal(pace.coverageTier, 'insufficient');
  assert.equal(pace.medianBaseline, null, 'never invent a median from fewer than 3 comparable months');
  assert.equal(pace.vsMedian, null);
  assert.equal(pace.paceLabel, null);
  assert.deepEqual(pace.drivers, []);
});

test('incomplete historical coverage (a month missing days inside its matched window) is excluded from the median, not treated as a partial-month zero', async (t) => {
  const source = `${TAG}-incomplete`;
  t.after(async () => { await db.query(`DELETE FROM metrics WHERE source = $1`, [source]); });

  await seedAggregateMonth(source, 2026, 7, ELAPSED_DAYS, 200);
  // 3 fully-covered eligible months...
  for (let monthsAgo = 1; monthsAgo <= 3; monthsAgo++) {
    const { y, m, matchedDay } = targetForMonthsAgo(monthsAgo);
    await seedAggregateMonth(source, y, m, matchedDay, 180);
  }
  // ...and one month with a REAL GAP: only half its matched window synced.
  {
    const { y, m, matchedDay } = targetForMonthsAgo(4);
    const partialDays = Math.max(1, Math.floor(matchedDay / 2));
    await seedAggregateMonth(source, y, m, partialDays, 90);
  }

  const pace = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ, monthsBack: 12 });
  assert.equal(pace.monthsUsed, 3, 'the partially-synced 4th month must be excluded, not counted as a genuine (low) data point');
  const gapMonth = pace.monthsBreakdown.find((mo) => mo.monthsAgo === 4);
  assert.equal(gapMonth.eligible, false);
});

test('required: zero or a too-small baseline hides the percentage comparison, but the dollar comparison and label still show', async (t) => {
  const source = `${TAG}-tinybaseline`;
  t.after(async () => { await db.query(`DELETE FROM metrics WHERE source = $1`, [source]); });

  await seedAggregateMonth(source, 2026, 7, ELAPSED_DAYS, 200);
  for (let monthsAgo = 1; monthsAgo <= 6; monthsAgo++) {
    const { y, m, matchedDay } = targetForMonthsAgo(monthsAgo);
    await seedAggregateMonth(source, y, m, matchedDay, 80); // below MIN_MEANINGFUL_BASELINE (150)
  }

  const pace = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ, monthsBack: 12 });
  assert.equal(pace.medianBaseline, 80);
  assert.equal(pace.vsMedian.dollars, 120);
  assert.equal(pace.vsMedian.pct, null, 'a $80 baseline is too small for a percentage to mean anything');
  assert.equal(pace.paceLabel, 'well_above_typical', 'the qualitative label is NOT suppressed, only the percentage');
});

test('required: category drivers — an elevated category is named with correct excess/median; an ordinary category, a transfer, and rent never appear', async (t) => {
  const source = `${TAG}-drivers`;
  t.after(async () => {
    await db.query(`DELETE FROM metrics WHERE source = $1`, [source]);
    await db.query(`DELETE FROM documents WHERE source = 'monarch' AND external_id LIKE $1`, [`${TAG}-drv%`]);
  });

  // Aggregate: current $400 vs a $200 median across 6 eligible months —
  // $200 of excess, well above the $100 driver floor, so drivers ARE computed.
  await seedAggregateMonth(source, 2026, 7, ELAPSED_DAYS, 400);
  for (let monthsAgo = 1; monthsAgo <= 6; monthsAgo++) {
    const { y, m, matchedDay } = targetForMonthsAgo(monthsAgo);
    await seedAggregateMonth(source, y, m, matchedDay, 200);
    // Historical category spend for the same eligible months.
    await seedCategoryDoc(`${TAG}-drv-ent-${monthsAgo}`, y, m, 'Entertainment', -50);
    await seedCategoryDoc(`${TAG}-drv-grc-${monthsAgo}`, y, m, 'Groceries', -150);
  }
  // Current month: Entertainment spikes ($300 vs $50 median -> $250 excess,
  // a real driver); Groceries barely moves ($160 vs $150 -> $10 excess, NOT
  // material); a Transfer and a Rent payment are both huge but must never
  // be named as "drivers" — they aren't discretionary spending at all.
  await seedCategoryDoc(`${TAG}-drv-ent-cur`, 2026, 7, 'Entertainment', -300);
  await seedCategoryDoc(`${TAG}-drv-grc-cur`, 2026, 7, 'Groceries', -160);
  await seedCategoryDoc(`${TAG}-drv-xfer-cur`, 2026, 7, 'Transfer', -5000);
  await seedCategoryDoc(`${TAG}-drv-rent-cur`, 2026, 7, 'Rent', -3000);

  const pace = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ, monthsBack: 12 });
  assert.equal(pace.vsMedian.dollars, 200);
  assert.equal(pace.drivers.length, 1, `expected exactly one material driver, got: ${JSON.stringify(pace.drivers)}`);
  const [driver] = pace.drivers;
  assert.equal(driver.category, 'Entertainment');
  assert.equal(driver.currentAmount, 300);
  assert.equal(driver.matchedMedian, 50);
  assert.equal(driver.excessDollars, 250);
  const categories = pace.drivers.map((d) => d.category);
  assert.ok(!categories.includes('Groceries'), 'a $10 excess is not material enough to be a driver');
  assert.ok(!categories.includes('Transfer'), 'a transfer is never discretionary spending, however large');
  assert.ok(!categories.includes('Rent'), 'a fixed housing payment is never a discretionary driver');
});

test('required: America/New_York DST boundaries — spring-forward (March) and fall-back (November) still include day 1 of the month', async (t) => {
  const source = `${TAG}-dst`;
  t.after(async () => { await db.query(`DELETE FROM metrics WHERE source = $1`, [source]); });
  await sourcesStore.registerSource({ id: source, domain: 'wealth', displayName: 'wealth-pace DST test' }).catch(() => {});

  // Spring forward: DST begins March 8, 2026 — asOf a couple days later,
  // already in EDT (UTC-4).
  const springAsOf = new Date('2026-03-10T12:00:00Z'); // 08:00 EDT local -> March 10
  await metricsStore.insertMetrics([
    { ts: new Date('2026-03-01T00:00:00Z'), domain: 'wealth', metric: 'spending_discretionary', value: 42, source },
  ]);
  const springPace = await computeDiscretionaryMatchedPace({ asOf: springAsOf, tz: TZ, monthsBack: 1 });
  assert.equal(springPace.elapsedDays, 10);
  assert.equal(springPace.currentAmount, 42, 'March 1st spend must be included despite the DST transition a week earlier');
  await db.query(`DELETE FROM metrics WHERE source = $1`, [source]);

  // Fall back: DST ends November 1, 2026 — asOf a few days later, already in EST (UTC-5).
  const fallAsOf = new Date('2026-11-05T12:00:00Z'); // 07:00 EST local -> November 5
  await metricsStore.insertMetrics([
    { ts: new Date('2026-11-01T00:00:00Z'), domain: 'wealth', metric: 'spending_discretionary', value: 77, source },
  ]);
  const fallPace = await computeDiscretionaryMatchedPace({ asOf: fallAsOf, tz: TZ, monthsBack: 1 });
  assert.equal(fallPace.elapsedDays, 5);
  assert.equal(fallPace.currentAmount, 77, 'November 1st spend must be included despite the DST transition days earlier');
});

test('required: identity between Wealth (wealth-landing), BrainSnapshot, and Ask facts — all three report the exact same comparison', async (t) => {
  const source = `${TAG}-identity`;
  t.after(async () => { await db.query(`DELETE FROM metrics WHERE source = $1`, [source]); });

  await seedAggregateMonth(source, 2026, 7, ELAPSED_DAYS, 300);
  for (let monthsAgo = 1; monthsAgo <= 6; monthsAgo++) {
    const { y, m, matchedDay } = targetForMonthsAgo(monthsAgo);
    await seedAggregateMonth(source, y, m, matchedDay, 150);
  }

  const direct = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ });
  const landing = await buildWealthLandingProjection({ asOf: ASOF, tz: TZ });
  const snapshot = await buildBrainSnapshot({ asOf: ASOF, tz: TZ, include: { calendar: false } });
  const facts = canonicalFacts(snapshot);

  assert.ok(direct.medianBaseline != null, 'sanity: this scenario must produce a real comparison');
  assert.equal(landing.numbers.mtdDiscretionary.comparison.vsMedian.dollars, direct.vsMedian.dollars);
  assert.equal(landing.numbers.mtdDiscretionary.comparison.paceLabel, direct.paceLabel);
  assert.equal(snapshot.wealth.value.spendingPace.vsMedian.dollars, direct.vsMedian.dollars, 'BrainSnapshot must report the identical dollar figure');
  assert.equal(facts.spendingPaceVsTypical.dollars, direct.vsMedian.dollars, 'the Ask/Chief-Brief claim-validation fact must be the identical value too');
  assert.equal(facts.spendingPaceVsTypical.label, direct.paceLabel);
});

// Product-audit hardening pass, item 4: computeDiscretionaryMatchedPace runs
// up to 12 sequential historical aggregate queries — previously BOTH
// buildBrainSnapshot AND buildWealthLandingProjection independently invoked
// it for the SAME logical "build a fresh morning brief" request. These tests
// instrument the actual exported function (monkey-patched on the wealth-pace
// module, which wealth-landing.js re-requires fresh inside its own function
// body every call, so the patched stub is picked up) to prove the real
// production call sites now resolve it exactly once.
test('required: buildWealthLandingProjection does NOT recompute matched-pace when a caller already resolved it (spendingPace param)', async (t) => {
  const source = `${TAG}-dedupe1`;
  t.after(async () => { await db.query(`DELETE FROM metrics WHERE source = $1`, [source]); });

  // Needs real current-month + trailing-month coverage so the projection's
  // mtdDiscretionary.comparison block is actually populated (non-null) —
  // otherwise the assertion below has nothing to compare against.
  await seedAggregateMonth(source, 2026, 7, ELAPSED_DAYS, 300);
  for (let monthsAgo = 1; monthsAgo <= 6; monthsAgo++) {
    const { y, m, matchedDay } = targetForMonthsAgo(monthsAgo);
    await seedAggregateMonth(source, y, m, matchedDay, 150);
  }

  const wealthPaceMod = require('../../src/services/wealth-pace');
  const original = wealthPaceMod.computeDiscretionaryMatchedPace;
  let calls = 0;
  wealthPaceMod.computeDiscretionaryMatchedPace = async (...args) => { calls += 1; return original(...args); };
  t.after(() => { wealthPaceMod.computeDiscretionaryMatchedPace = original; });

  const already = await original({ asOf: ASOF, tz: TZ });
  assert.ok(already.medianBaseline != null, 'sanity: this scenario must produce a real comparison');
  calls = 0; // reset — only count calls made BY buildWealthLandingProjection below

  const landing = await buildWealthLandingProjection({ asOf: ASOF, tz: TZ, spendingPace: already });
  assert.equal(calls, 0, 'a provided spendingPace must be reused as-is, never recomputed');
  assert.equal(landing.numbers.mtdDiscretionary.comparison.paceLabel, already.paceLabel);
});

test('required: buildWealthLandingProjection DOES compute matched-pace itself when no caller has resolved it yet (backward compatible)', async (t) => {
  const wealthPaceMod = require('../../src/services/wealth-pace');
  const original = wealthPaceMod.computeDiscretionaryMatchedPace;
  let calls = 0;
  wealthPaceMod.computeDiscretionaryMatchedPace = async (...args) => { calls += 1; return original(...args); };
  t.after(() => { wealthPaceMod.computeDiscretionaryMatchedPace = original; });

  await buildWealthLandingProjection({ asOf: ASOF, tz: TZ });
  assert.equal(calls, 1, 'with no spendingPace provided, the projection must still compute its own (existing callers are unaffected)');
});

test('required: one logical "build a fresh morning brief" (BrainSnapshot + Wealth landing reusing its value) resolves matched-pace exactly once', async (t) => {
  const wealthPaceMod = require('../../src/services/wealth-pace');
  const original = wealthPaceMod.computeDiscretionaryMatchedPace;
  let calls = 0;
  wealthPaceMod.computeDiscretionaryMatchedPace = async (...args) => { calls += 1; return original(...args); };
  t.after(() => { wealthPaceMod.computeDiscretionaryMatchedPace = original; });

  const snapshot = await buildBrainSnapshot({ asOf: ASOF, tz: TZ, include: { calendar: false } });
  assert.equal(calls, 1, 'sanity: BrainSnapshot itself resolves it exactly once');

  // Mirrors routes/briefing.js's fresh-build wiring: reuse BrainSnapshot's
  // already-resolved value instead of letting the projection recompute it.
  await buildWealthLandingProjection({ asOf: ASOF, tz: TZ, spendingPace: snapshot.wealth.value.spendingPace });
  assert.equal(calls, 1, 'the full build must not trigger a SECOND invocation for the same logical request');
});

test('required: ask.js resolves matched-pace exactly once per financial question (wealthContext + claim-validation facts share one Promise)', async (t) => {
  const wealthPaceMod = require('../../src/services/wealth-pace');
  const original = wealthPaceMod.computeDiscretionaryMatchedPace;
  let calls = 0;
  wealthPaceMod.computeDiscretionaryMatchedPace = async (...args) => { calls += 1; return original(...args); };
  t.after(() => { wealthPaceMod.computeDiscretionaryMatchedPace = original; });

  const llm = require('../../src/llm');
  const originalGenerateText = llm.generateText;
  const originalEmbed = llm.embed;
  llm.embed = async () => [null];
  llm.generateText = async () => 'Your discretionary spending looks about typical this month.';
  try {
    const { ask } = require('../../src/chat/ask');
    await ask('How is my spending pace this month compared to usual?', { history: [] });
  } finally {
    llm.generateText = originalGenerateText;
    llm.embed = originalEmbed;
  }
  assert.equal(calls, 1, 'a single financial Ask question must resolve matched-pace exactly once, not once for the prompt and once for claim validation');
});
