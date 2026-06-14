const test = require('node:test');
const assert = require('node:assert/strict');
const { dismissKey, applyDismissals } = require('../src/store/dismissedInsights');

test('Honda car-payment key is stable as the dollar amount drifts month to month', () => {
  const june = { type: 'subscription_review', title: 'Review: Honda Financial Services is $6,924/yr' };
  const july = { type: 'subscription_review', title: 'Review: Honda Financial Services is $6,901/yr' };
  assert.equal(dismissKey(june), dismissKey(july)); // same key despite different amount
  assert.match(dismissKey(june), /honda financial services/);
});

test('different merchants get different keys', () => {
  const honda = { type: 'subscription_review', title: 'Review: Honda Financial is $6,924/yr' };
  const netflix = { type: 'subscription_review', title: 'Review: Netflix is $230/yr' };
  assert.notEqual(dismissKey(honda), dismissKey(netflix));
});

test('type is part of the key — same title, different type, different key', () => {
  const a = { type: 'over_budget', title: 'Dining out' };
  const b = { type: 'spending_pattern', title: 'Dining out' };
  assert.notEqual(dismissKey(a), dismissKey(b));
});

test('percentages and counts are stripped too', () => {
  const a = { type: 'spending_pattern', title: 'Dining trending 32% above your usual' };
  const b = { type: 'spending_pattern', title: 'Dining trending 47% above your usual' };
  assert.equal(dismissKey(a), dismissKey(b));
});

test('applyDismissals removes dismissed insights and stamps keys on survivors', () => {
  const insights = [
    { type: 'subscription_review', title: 'Review: Honda Financial is $6,924/yr' },
    { type: 'savings_rate', title: 'Saving 22% of income (30d)' },
  ];
  const dismissed = new Set([dismissKey(insights[0])]);
  const out = applyDismissals(insights, dismissed);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'savings_rate');
  assert.ok(out[0].dismissKey, 'survivor is stamped with its dismissKey');
});

test('applyDismissals is safe on non-arrays', () => {
  assert.equal(applyDismissals(null, new Set()), null);
  assert.equal(applyDismissals(undefined, new Set()), undefined);
});
