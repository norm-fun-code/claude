// Production incident: Wealth double-counting. Pure unit tests for
// store/documents.js's dedupeCanonicalPairs — the defensive read-time
// safety net that drops a stale non-canonical duplicate ONLY when a
// canonical `monarch:<digits>` sibling exists for the identical
// day/category/amount/merchant/account fingerprint, never a standalone
// row or a genuine same-fingerprint pair with no canonical id at all.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dedupeCanonicalPairs } = require('../src/store/documents');

const base = { day: '2026-07-06', category: 'Clothing', amount: -247.4, merchant: 'gap', account: "nancy's venture x" };

test('required: a canonical + non-canonical pair for the identical fingerprint collapses to just the canonical row', () => {
  const rows = [
    { ...base, external_id: 'c13476c499545df10f417ac4' },
    { ...base, external_id: 'monarch:248637361147612098' },
  ];
  const out = dedupeCanonicalPairs(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].external_id, 'monarch:248637361147612098');
});

test('required: a standalone canonical row with no non-canonical sibling is left alone', () => {
  const rows = [{ ...base, external_id: 'monarch:248637361147612098' }];
  const out = dedupeCanonicalPairs(rows);
  assert.equal(out.length, 1);
});

test('required: a standalone non-canonical row with no canonical sibling is left alone (never dropped)', () => {
  const rows = [{ ...base, external_id: 'c13476c499545df10f417ac4' }];
  const out = dedupeCanonicalPairs(rows);
  assert.equal(out.length, 1);
});

test('required: two genuinely separate same-fingerprint rows with NEITHER canonical must both count (no canonical sibling to trigger collapse)', () => {
  const rows = [
    { ...base, external_id: 'txn-a' },
    { ...base, external_id: 'txn-b' },
  ];
  const out = dedupeCanonicalPairs(rows);
  assert.equal(out.length, 2, 'two legitimately separate same-day purchases must both survive when no canonical id is present at all');
});

test('required: a different day/category/amount/merchant/account is never grouped with an unrelated canonical row', () => {
  const rows = [
    { day: '2026-07-06', category: 'Clothing', amount: -247.4, merchant: 'gap', account: 'checking', external_id: 'monarch:1' },
    { day: '2026-07-07', category: 'Clothing', amount: -247.4, merchant: 'gap', account: 'checking', external_id: 'legacy-id' },
  ];
  const out = dedupeCanonicalPairs(rows);
  assert.equal(out.length, 2, 'different days must never be treated as the same transaction');
});

test('required: two canonical rows sharing a fingerprint (a real upsert anomaly, not this bug) are left untouched', () => {
  const rows = [
    { ...base, external_id: 'monarch:1' },
    { ...base, external_id: 'monarch:2' },
  ];
  const out = dedupeCanonicalPairs(rows);
  assert.equal(out.length, 2, 'this function only targets the canonical+non-canonical pairing; two distinct canonical ids are a different issue');
});
