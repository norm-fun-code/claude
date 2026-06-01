const test = require('node:test');
const assert = require('node:assert/strict');
const { detectSubscriptions, computeSubscriptionInsights, normalizeMerchant, cadenceOf } = require('../src/intelligence/subscriptions');

// Generate monthly charges for a merchant: `n` charges, `amount` each, ending
// `endDaysAgo` before asOf, ~30 days apart.
function monthly(merchant, amount, n, endDaysAgo = 5, asOf = new Date('2026-06-01')) {
  const txns = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(asOf.getTime() - (endDaysAgo + i * 30) * 864e5);
    txns.push({ day: d.toISOString().slice(0, 10), merchant, amount, category: 'Subscriptions' });
  }
  return txns;
}

const ASOF = new Date('2026-06-01');

test('normalizeMerchant collapses store codes and noise', () => {
  assert.equal(normalizeMerchant('Netflix.com'), 'netflix');
  assert.equal(normalizeMerchant('SPOTIFY P0A1B2'), 'spotify');
  // Same raw merchant always normalizes to the same key (so charges group).
  assert.equal(normalizeMerchant('AMZN Mktp US*2X9G'), normalizeMerchant('AMZN Mktp US*2X9G'));
  assert.equal(normalizeMerchant('  Hulu  '), 'hulu');
});

test('cadenceOf classifies common billing periods', () => {
  assert.equal(cadenceOf(30).label, 'monthly');
  assert.equal(cadenceOf(7).label, 'weekly');
  assert.equal(cadenceOf(365).label, 'yearly');
  assert.equal(cadenceOf(17), null); // irregular
});

test('detects a clean monthly subscription', () => {
  const txns = monthly('Netflix', 15.99, 5, 5, ASOF);
  const subs = detectSubscriptions(txns, { asOf: ASOF });
  assert.equal(subs.length, 1);
  assert.equal(subs[0].cadence, 'monthly');
  assert.equal(subs[0].amount, 15.99);
  assert.equal(subs[0].annual, Math.round(15.99 * 12));
  assert.ok(subs[0].active);
});

test('ignores irregular / one-off spend at the same merchant', () => {
  // Random amounts, irregular dates → not a subscription.
  const txns = [
    { day: '2026-05-01', merchant: 'Amazon', amount: 40, category: 'Shopping' },
    { day: '2026-05-09', merchant: 'Amazon', amount: 12, category: 'Shopping' },
    { day: '2026-05-22', merchant: 'Amazon', amount: 88, category: 'Shopping' },
  ];
  const subs = detectSubscriptions(txns, { asOf: ASOF });
  assert.equal(subs.length, 0);
});

test('requires the minimum number of occurrences', () => {
  const txns = monthly('Hulu', 9.99, 2, 5, ASOF); // only 2
  assert.equal(detectSubscriptions(txns, { asOf: ASOF }).length, 0);
});

test('marks an old subscription inactive (likely cancelled)', () => {
  // 4 monthly charges, but the last was ~5 months ago.
  const txns = monthly('Gym', 49, 4, 150, ASOF);
  const subs = detectSubscriptions(txns, { asOf: ASOF });
  assert.equal(subs.length, 1);
  assert.equal(subs[0].active, false);
});

test('computeSubscriptionInsights summarizes active recurring spend', () => {
  const txns = [
    ...monthly('Netflix', 15.99, 5, 5, ASOF),
    ...monthly('Spotify', 11.99, 6, 3, ASOF),
    ...monthly('NYTimes', 25, 4, 4, ASOF),
  ];
  const insights = computeSubscriptionInsights(txns, { asOf: ASOF });
  assert.ok(insights.length >= 1);
  assert.equal(insights[0].type, 'subscriptions');
  assert.match(insights[0].title, /3 subscriptions/);
  assert.ok(insights[0].evidence.totalMonthly > 50);
  // NYTimes at $300/yr triggers the review flag.
  assert.ok(insights.some((i) => i.type === 'subscription_review'));
});
