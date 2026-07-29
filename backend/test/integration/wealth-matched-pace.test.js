// Real-Postgres regression tests for the discretionary MTD matched-pace
// baseline (backend/src/services/wealth-pace.js) — coverage-tier safeguards,
// median-vs-outlier behavior, per-category drivers, DST-safe boundaries, and
// cross-surface identity between Wealth, BrainSnapshot, and Ask.
//
// Wealth matched-pace audit: wealth-pace.js no longer reads the `metrics`
// table at all — current, previous, and every historical month are now
// computed LIVE from the canonical `documents` transaction corpus through
// discretionarySpend.js's one shared, versioned predicate. So every fixture
// below seeds transaction-level `documents` rows (never precomputed metric
// rows) via documentsStore.upsertDocument, matching how Monarch data
// actually lands in production.
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
const { DISCRETIONARY_DEFINITION_VERSION } = require('../../src/services/discretionarySpend');
const { buildWealthLandingProjection } = require('../../src/services/wealth-landing');
const { buildBrainSnapshot, canonicalFacts } = require('../../src/brain/snapshot');

const TZ = 'America/New_York';
const TAG = `wpace-${Date.now()}`;

after(async () => {
  await db.query(`DELETE FROM metrics WHERE source LIKE $1`, [`${TAG}%`]);
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

/** A single canonical Monarch transaction document — the ONLY kind of
 *  fixture this file ever writes; `discretionaryBreakdown` (and therefore
 *  every historical/current amount in computeDiscretionaryMatchedPace)
 *  reads exclusively from `documents`, never `metrics`. */
async function seedDoc({ externalId, occurredAt, category, amount, merchant = category, account = 'checking' }) {
  return documentsStore.upsertDocument({
    source: 'monarch', domain: 'wealth', externalId, title: category, content: category,
    occurredAt, metadata: { category, amount: String(amount), merchant, account },
  });
}

/** One transaction on `day` of local month {y, m} in `category`, spending
 *  `positiveAmount` dollars (Monarch's own sign convention: a negative
 *  metadata.amount is a purchase) — day 1 is always inside any matched
 *  window (matchedDay is always >= 1), so callers that don't care about the
 *  exact day just pass day=1. */
async function seedMonthSpend(externalId, y, m, day, positiveAmount, category = 'General Merchandise') {
  await seedDoc({ externalId, occurredAt: ymd(y, m, day), category, amount: String(-positiveAmount) });
}

function cleanupDocsAfter(t, prefix) {
  t.after(async () => { await db.query(`DELETE FROM documents WHERE source = 'monarch' AND external_id LIKE $1`, [`${prefix}%`]); });
}

function targetForMonthsAgo(monthsAgo) {
  const target = monthOffset(2026, 7, monthsAgo);
  const targetDays = daysInMonth(target.y, target.m);
  const matchedDay = matchedDayOfMonth(ELAPSED_DAYS, DAYS_IN_CURRENT, targetDays);
  return { ...target, targetDays, matchedDay };
}

test('required: 6-13 eligible months -> "typical" pace, the median resists a single outlier month (proving median, not mean), and a genuinely high month renders "comfortably above typical"', async (t) => {
  const prefix = `${TAG}-typical`;
  cleanupDocsAfter(t, prefix);

  // Current month: $260 discretionary spend over the elapsed 15-day window.
  await seedMonthSpend(`${prefix}-cur`, 2026, 7, 1, 260);
  // 5 trailing months at $200 each (full coverage), 1 trailing month (the
  // 6th, and therefore the account's earliest-ever transaction) as a huge
  // $10,000 outlier — still 6 eligible months -> "typical".
  for (let monthsAgo = 1; monthsAgo <= 5; monthsAgo++) {
    const { y, m } = targetForMonthsAgo(monthsAgo);
    await seedMonthSpend(`${prefix}-h${monthsAgo}`, y, m, 1, 200);
  }
  {
    const { y, m } = targetForMonthsAgo(6);
    await seedMonthSpend(`${prefix}-h6`, y, m, 1, 10000);
  }
  // Months 7+ deliberately unseeded: the account's earliest document is
  // month 6's, so months 7+ fail the earliestDate <= fromYmd coverage gate
  // and are excluded — never miscounted as genuine $0 months.

  const pace = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ });
  assert.equal(pace.coverageTier, 'typical');
  assert.equal(pace.monthsUsed, 6, 'only the 6 covered months count; months before the account\'s earliest transaction are gaps, not zeros');
  assert.equal(pace.medianBaseline, 200, 'median of [200,200,200,200,200,10000] is 200 — a mean would have been pulled to ~1750 by the outlier');
  assert.equal(pace.currentAmount, 260);
  assert.equal(pace.vsMedian.dollars, 60);
  assert.equal(pace.vsMedian.pct, 30);
  assert.equal(pace.paceLabel, 'comfortably_above', '30% above the median is past the +/-20% "comfortably" band');
  // Previous month (monthsAgo=1) was one of the $200 eligible months.
  assert.equal(pace.previousMonthAmount, 200);
  assert.equal(pace.vsPreviousMonth.dollars, 60);
});

test('required: 5 eligible months (one short of the new 6-month floor) suppresses the comparison entirely — never a "recent, provisional" percentage from too thin a sample', async (t) => {
  const prefix = `${TAG}-five`;
  cleanupDocsAfter(t, prefix);

  await seedMonthSpend(`${prefix}-cur`, 2026, 7, 1, 150);
  for (let monthsAgo = 1; monthsAgo <= 5; monthsAgo++) {
    const { y, m } = targetForMonthsAgo(monthsAgo);
    await seedMonthSpend(`${prefix}-h${monthsAgo}`, y, m, 1, 150);
  }

  const pace = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ });
  assert.equal(pace.monthsUsed, 5);
  assert.equal(pace.coverageTier, 'insufficient', 'MIN_COMPARABLE_MONTHS=6 — there is no more a "recent" 3-5 month tier');
  assert.equal(pace.medianBaseline, null, 'never invent a median from fewer than 6 comparable months');
  assert.equal(pace.vsMedian, null);
  assert.equal(pace.paceLabel, null);
  assert.deepEqual(pace.drivers, []);
});

test('required: fewer than 6 eligible months -> the historical comparison is OMITTED, not invented', async (t) => {
  const prefix = `${TAG}-insufficient`;
  cleanupDocsAfter(t, prefix);

  await seedMonthSpend(`${prefix}-cur`, 2026, 7, 1, 150);
  for (let monthsAgo = 1; monthsAgo <= 2; monthsAgo++) {
    const { y, m } = targetForMonthsAgo(monthsAgo);
    await seedMonthSpend(`${prefix}-h${monthsAgo}`, y, m, 1, 150);
  }

  const pace = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ });
  assert.equal(pace.monthsUsed, 2);
  assert.equal(pace.coverageTier, 'insufficient');
  assert.equal(pace.medianBaseline, null);
  assert.equal(pace.vsMedian, null);
  assert.equal(pace.paceLabel, null);
  assert.deepEqual(pace.drivers, []);
});

test('required: a real gap in the account\'s own transaction history (no Monarch coverage before a month even starts) excludes that month from the median, never treats the gap as a genuine data point', async (t) => {
  const prefix = `${TAG}-gap`;
  cleanupDocsAfter(t, prefix);

  await seedMonthSpend(`${prefix}-cur`, 2026, 7, 1, 200);
  // 3 fully-covered eligible months (day 1 of each)...
  for (let monthsAgo = 1; monthsAgo <= 3; monthsAgo++) {
    const { y, m } = targetForMonthsAgo(monthsAgo);
    await seedMonthSpend(`${prefix}-h${monthsAgo}`, y, m, 1, 180);
  }
  // ...and a 4th month whose ONLY document falls mid-window (on its own
  // matchedDay, not day 1) — this becomes the account's earliest-ever
  // transaction, which is itself AFTER this month's window started, so the
  // month fails the coverage gate despite having a real, in-window document.
  const gap = targetForMonthsAgo(4);
  await seedMonthSpend(`${prefix}-h4`, gap.y, gap.m, gap.matchedDay, 90);

  const pace = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ });
  assert.equal(pace.monthsUsed, 3, 'the 4th month must be excluded despite having real transaction data inside its own matched window');
  const gapMonth = pace.monthsBreakdown.find((mo) => mo.monthsAgo === 4);
  assert.equal(gapMonth.eligible, false);
  assert.equal(gapMonth.amount, 90, 'the computed amount is still reported for auditability, even though it is excluded from the median');
});

test('required: a stale legacy metrics-table row can no longer contaminate the median — historical months are computed ONLY from documents, so a leftover metrics-table figure with no backing transactions is simply invisible', async (t) => {
  const prefix = `${TAG}-legacy`;
  cleanupDocsAfter(t, prefix);
  t.after(async () => { await db.query(`DELETE FROM metrics WHERE source = $1`, [prefix]); });
  await sourcesStore.registerSource({ id: prefix, domain: 'wealth', displayName: 'wealth-pace legacy-row test' }).catch(() => {});

  await seedMonthSpend(`${prefix}-cur`, 2026, 7, 1, 200);
  for (let monthsAgo = 1; monthsAgo <= 6; monthsAgo++) {
    const { y, m } = targetForMonthsAgo(monthsAgo);
    await seedMonthSpend(`${prefix}-h${monthsAgo}`, y, m, 1, 180);
  }
  // A 7th month has ONLY a legacy metrics-table row (as if written by the
  // pre-audit code path) — no supporting `documents` rows at all, and no
  // document anywhere before it, so the coverage gate excludes it even
  // though the stale aggregate would otherwise be a huge, median-skewing
  // outlier ($9,000) if it were still being read.
  const legacy = targetForMonthsAgo(7);
  await metricsStore.insertMetrics([
    { ts: new Date(`${ymd(legacy.y, legacy.m, 1)}T00:00:00Z`), domain: 'wealth', metric: 'spending_discretionary', value: 9000, source: prefix },
  ]);

  const pace = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ });
  assert.equal(pace.monthsUsed, 6, 'the legacy-only 7th month never enters the median pool');
  assert.equal(pace.medianBaseline, 180, 'unaffected by the stale $9,000 legacy row');
  const legacyMonth = pace.monthsBreakdown.find((mo) => mo.monthsAgo === 7);
  assert.equal(legacyMonth.eligible, false, 'a month with no documents before it is a coverage gap, regardless of what the metrics table says');
  assert.equal(legacyMonth.amount, 0, 'with zero documents in its window, its computed discretionary amount is 0 — the $9,000 legacy figure is never read at all');
});

test('required: duplicate-source transactions (two importers writing the same purchase twice) are never double-counted', async (t) => {
  const prefix = `${TAG}-dup`;
  cleanupDocsAfter(t, prefix);

  // Two documents, same calendar date/merchant/amount/account but different
  // external_ids — exactly documents.categorySpendInRange's DISTINCT ON key
  // (occurred_at::date, merchant, amount, account) — must collapse to ONE
  // $75 transaction, not $150.
  await seedDoc({ externalId: `${prefix}-a`, occurredAt: ymd(2026, 7, 1), category: 'General Merchandise', amount: '-75', merchant: 'Acme Store', account: 'checking' });
  await seedDoc({ externalId: `${prefix}-b`, occurredAt: ymd(2026, 7, 1), category: 'General Merchandise', amount: '-75', merchant: 'Acme Store', account: 'checking' });

  const breakdown = await require('../../src/services/discretionarySpend').discretionaryBreakdown({ fromYmd: '2026-07-01', toYmd: '2026-07-01' });
  assert.equal(breakdown.discretionaryTotal, 75, 'the duplicate-looking second document must not double the total');
});

test('required: rent/housing is excluded from BOTH the current month\'s and every historical month\'s discretionary total, never just the current one', async (t) => {
  const prefix = `${TAG}-rent`;
  cleanupDocsAfter(t, prefix);

  // Current month: $200 discretionary + a $3,000 rent payment.
  await seedMonthSpend(`${prefix}-cur-disc`, 2026, 7, 1, 200);
  await seedDoc({ externalId: `${prefix}-cur-rent`, occurredAt: ymd(2026, 7, 1), category: 'Rent', amount: '-3000' });
  // 6 eligible historical months, EACH also carrying a large rent payment
  // alongside its discretionary spend.
  for (let monthsAgo = 1; monthsAgo <= 6; monthsAgo++) {
    const { y, m } = targetForMonthsAgo(monthsAgo);
    await seedMonthSpend(`${prefix}-h${monthsAgo}-disc`, y, m, 1, 180);
    await seedDoc({ externalId: `${prefix}-h${monthsAgo}-rent`, occurredAt: ymd(y, m, 1), category: 'Rent', amount: '-3000' });
  }

  const pace = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ });
  assert.equal(pace.currentAmount, 200, 'the $3,000 rent payment must never inflate the current discretionary total');
  assert.equal(pace.medianBaseline, 180, 'nor any historical month\'s — rent is excluded from every month by the SAME predicate');
  assert.equal(pace.fixedExcluded.total, 3000, 'the current month\'s rent exclusion is still reported, just not counted as discretionary');
  assert.ok(pace.monthsBreakdown.filter((mo) => mo.eligible).every((mo) => mo.fixedExcluded.total === 3000), 'every eligible historical month reports its own rent exclusion too');
});

test('required: the total-economic-spend figure and the discretionary figure are never confused — a large fixed payment inflates one but never the other', async (t) => {
  const prefix = `${TAG}-totalvsdisc`;
  cleanupDocsAfter(t, prefix);

  await seedMonthSpend(`${prefix}-disc`, 2026, 7, 1, 200);
  await seedDoc({ externalId: `${prefix}-rent`, occurredAt: ymd(2026, 7, 1), category: 'Rent', amount: '-3000' });
  await seedDoc({ externalId: `${prefix}-xfer`, occurredAt: ymd(2026, 7, 1), category: 'Transfer', amount: '-5000' });

  const { discretionaryBreakdown } = require('../../src/services/discretionarySpend');
  const breakdown = await discretionaryBreakdown({ fromYmd: '2026-07-01', toYmd: '2026-07-01' });
  assert.equal(breakdown.discretionaryTotal, 200);
  assert.equal(breakdown.totalEconomicSpend, 3200, 'discretionary + fixed (rent) — but NEVER the transfer, which is not economic spend at all');
  assert.notEqual(breakdown.totalEconomicSpend, breakdown.discretionaryTotal, 'the two figures must never collapse into one number');

  // And the matched-pace comparison itself is built exclusively from
  // discretionaryTotal — never accidentally from totalEconomicSpend.
  for (let monthsAgo = 1; monthsAgo <= 6; monthsAgo++) {
    const { y, m } = targetForMonthsAgo(monthsAgo);
    await seedMonthSpend(`${prefix}-h${monthsAgo}`, y, m, 1, 180);
  }
  const pace = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ });
  assert.equal(pace.currentAmount, 200, 'currentAmount must be the discretionary figure, never the $3,200 total-economic-spend figure');
});

test('required: a full 13-month backfill (the recompute/backfill window) produces comparable history all the way back', async (t) => {
  const prefix = `${TAG}-backfill`;
  cleanupDocsAfter(t, prefix);

  await seedMonthSpend(`${prefix}-cur`, 2026, 7, 1, 300);
  for (let monthsAgo = 1; monthsAgo <= 13; monthsAgo++) {
    const { y, m } = targetForMonthsAgo(monthsAgo);
    await seedMonthSpend(`${prefix}-h${monthsAgo}`, y, m, 1, 150 + monthsAgo);
  }

  const pace = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ });
  assert.equal(pace.monthsConsidered, 13, 'DEFAULT_MONTHS_BACK is 13 — a "same month last year" comparison is always in reach once history goes back that far');
  assert.equal(pace.monthsUsed, 13, 'every one of the 13 backfilled months is eligible');
  assert.equal(pace.coverageTier, 'typical');
  assert.ok(pace.monthsBreakdown.every((mo) => mo.definitionVersion === DISCRETIONARY_DEFINITION_VERSION), 'every historical month reports the SAME canonical definition version as the current month');
});

test('required: the exact reported production bug — an 11%-below-typical month renders "slightly_below", never "comfortably_below"', async (t) => {
  const prefix = `${TAG}-eleven`;
  cleanupDocsAfter(t, prefix);

  await seedMonthSpend(`${prefix}-cur`, 2026, 7, 1, 8272);
  for (let monthsAgo = 1; monthsAgo <= 6; monthsAgo++) {
    const { y, m } = targetForMonthsAgo(monthsAgo);
    await seedMonthSpend(`${prefix}-h${monthsAgo}`, y, m, 1, 9337);
  }

  const pace = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ });
  assert.equal(pace.medianBaseline, 9337);
  assert.equal(pace.currentAmount, 8272);
  assert.equal(pace.paceLabel, 'slightly_below', '~11% below typical is inside the 10-20% "slightly" band, not past the 20% "comfortably" one');
});

test('required: zero or a too-small baseline hides the percentage comparison, but the dollar comparison and label still show', async (t) => {
  const prefix = `${TAG}-tinybaseline`;
  cleanupDocsAfter(t, prefix);

  await seedMonthSpend(`${prefix}-cur`, 2026, 7, 1, 200);
  for (let monthsAgo = 1; monthsAgo <= 6; monthsAgo++) {
    const { y, m } = targetForMonthsAgo(monthsAgo);
    await seedMonthSpend(`${prefix}-h${monthsAgo}`, y, m, 1, 80); // below MIN_MEANINGFUL_BASELINE (150)
  }

  const pace = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ });
  assert.equal(pace.medianBaseline, 80);
  assert.equal(pace.vsMedian.dollars, 120);
  assert.equal(pace.vsMedian.pct, null, 'an $80 baseline is too small for a percentage to mean anything');
  assert.equal(pace.paceLabel, 'comfortably_above', 'the qualitative label is NOT suppressed, only the percentage (ratio 2.5x is well past the +20% band)');
});

test('required: category drivers — an elevated category is named with correct excess/median; an ordinary category, a transfer, and rent never appear', async (t) => {
  const prefix = `${TAG}-drivers`;
  cleanupDocsAfter(t, prefix);

  // Historical months: Entertainment $50 + Groceries $150 = $200/month
  // discretionary baseline across 6 eligible months.
  for (let monthsAgo = 1; monthsAgo <= 6; monthsAgo++) {
    const { y, m } = targetForMonthsAgo(monthsAgo);
    await seedDoc({ externalId: `${prefix}-ent-${monthsAgo}`, occurredAt: ymd(y, m, 1), category: 'Entertainment', amount: '-50' });
    await seedDoc({ externalId: `${prefix}-grc-${monthsAgo}`, occurredAt: ymd(y, m, 1), category: 'Groceries', amount: '-150' });
  }
  // Current month: Entertainment spikes ($300 vs $50 median -> $250 excess,
  // a real driver); Groceries barely moves ($160 vs $150 -> $10 excess, NOT
  // material); a Transfer and a Rent payment are both huge but must never
  // be named as "drivers" — they aren't discretionary spending at all.
  await seedDoc({ externalId: `${prefix}-ent-cur`, occurredAt: ymd(2026, 7, 1), category: 'Entertainment', amount: '-300' });
  await seedDoc({ externalId: `${prefix}-grc-cur`, occurredAt: ymd(2026, 7, 1), category: 'Groceries', amount: '-160' });
  await seedDoc({ externalId: `${prefix}-xfer-cur`, occurredAt: ymd(2026, 7, 1), category: 'Transfer', amount: '-5000' });
  await seedDoc({ externalId: `${prefix}-rent-cur`, occurredAt: ymd(2026, 7, 1), category: 'Rent', amount: '-3000' });

  const pace = await computeDiscretionaryMatchedPace({ asOf: ASOF, tz: TZ });
  assert.equal(pace.currentAmount, 460, 'Entertainment (300) + Groceries (160) — never the transfer or rent');
  assert.equal(pace.medianBaseline, 200);
  assert.equal(pace.vsMedian.dollars, 260);
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
  const prefix = `${TAG}-dst`;
  cleanupDocsAfter(t, prefix);

  // Spring forward: DST begins March 8, 2026 — asOf a couple days later,
  // already in EDT (UTC-4).
  const springAsOf = new Date('2026-03-10T12:00:00Z'); // 08:00 EDT local -> March 10
  await seedMonthSpend(`${prefix}-spring`, 2026, 3, 1, 42);
  const springPace = await computeDiscretionaryMatchedPace({ asOf: springAsOf, tz: TZ, monthsBack: 1 });
  assert.equal(springPace.elapsedDays, 10);
  assert.equal(springPace.currentAmount, 42, 'March 1st spend must be included despite the DST transition a week earlier');

  // Fall back: DST ends November 1, 2026 — asOf a few days later, already in EST (UTC-5).
  const fallAsOf = new Date('2026-11-05T12:00:00Z'); // 07:00 EST local -> November 5
  await seedMonthSpend(`${prefix}-fall`, 2026, 11, 1, 77);
  const fallPace = await computeDiscretionaryMatchedPace({ asOf: fallAsOf, tz: TZ, monthsBack: 1 });
  assert.equal(fallPace.elapsedDays, 5);
  assert.equal(fallPace.currentAmount, 77, 'November 1st spend must be included despite the DST transition days earlier');
});

test('required: identity between Wealth (wealth-landing), BrainSnapshot, and Ask facts — all three report the exact same comparison and label', async (t) => {
  const prefix = `${TAG}-identity`;
  cleanupDocsAfter(t, prefix);

  await seedMonthSpend(`${prefix}-cur`, 2026, 7, 1, 300);
  for (let monthsAgo = 1; monthsAgo <= 6; monthsAgo++) {
    const { y, m } = targetForMonthsAgo(monthsAgo);
    await seedMonthSpend(`${prefix}-h${monthsAgo}`, y, m, 1, 150);
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
// several sequential historical queries — previously BOTH buildBrainSnapshot
// AND buildWealthLandingProjection independently invoked it for the SAME
// logical "build a fresh morning brief" request. These tests instrument the
// actual exported function (monkey-patched on the wealth-pace module, which
// wealth-landing.js re-requires fresh inside its own function body every
// call, so the patched stub is picked up) to prove the real production call
// sites now resolve it exactly once.
test('required: buildWealthLandingProjection does NOT recompute matched-pace when a caller already resolved it (spendingPace param)', async (t) => {
  const prefix = `${TAG}-dedupe1`;
  cleanupDocsAfter(t, prefix);

  // Needs real current-month + trailing-month coverage so the projection's
  // mtdDiscretionary.comparison block is actually populated (non-null) —
  // otherwise the assertion below has nothing to compare against.
  await seedMonthSpend(`${prefix}-cur`, 2026, 7, 1, 300);
  for (let monthsAgo = 1; monthsAgo <= 6; monthsAgo++) {
    const { y, m } = targetForMonthsAgo(monthsAgo);
    await seedMonthSpend(`${prefix}-h${monthsAgo}`, y, m, 1, 150);
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
