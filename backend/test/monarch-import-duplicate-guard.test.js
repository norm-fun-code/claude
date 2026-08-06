// Production incident (Aug 6 2026): an automated Monarch CSV re-import wrote
// 203 duplicate transaction documents in a single batch, doubling every
// Wealth category total (Rent read $11,390 against the true $5,695).
//
// Cause: a Monarch CSV export carries no transaction id, so
// connectors/monarch.js's mapTransactions falls back to a content hash for
// external_id — an id that can never collide with the `monarch:<id>` rows the
// API sync already wrote. upsertDocument's ON CONFLICT (source, external_id)
// therefore inserts rather than updates, and unlike the API sync this path
// runs no reconcile/prune afterwards, so nothing removes the second copy.
//
// These pin the import-time guard that skips a hash-id document whose
// transaction is already stored canonically.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { transactionFingerprint, withoutAlreadyCanonical } = require('../src/store/documents');

/** Shaped exactly like mapTransactions' document output. */
function importedDoc({ externalId, day, category, amount, merchant, account = "Norman's Venture X" }) {
  return {
    source: 'monarch', domain: 'wealth', externalId,
    occurredAt: day,
    metadata: { amount, category, merchant, account, tags: '' },
  };
}

test('required: a CSV row for a transaction already stored canonically is skipped', () => {
  const canonical = new Set([
    transactionFingerprint({ day: '2026-08-01', category: 'Entertainment & Recreation', amount: -63.94, merchant: 'AXS', account: "Norman's Venture X" }),
  ]);
  const docs = [importedDoc({ externalId: 'f500b5beb79fdbeb5c36a193', day: '2026-08-01', category: 'Entertainment & Recreation', amount: -63.94, merchant: 'AXS' })];
  const { kept, skipped } = withoutAlreadyCanonical(docs, canonical);
  assert.equal(skipped, 1, 'the hash-id restatement of an already-synced transaction must not be inserted');
  assert.equal(kept.length, 0);
});

test('required: a genuinely new CSV transaction still imports', () => {
  const canonical = new Set([
    transactionFingerprint({ day: '2026-08-01', category: 'Entertainment & Recreation', amount: -63.94, merchant: 'AXS', account: "Norman's Venture X" }),
  ]);
  const docs = [importedDoc({ externalId: 'newhash0000000000000000', day: '2026-08-04', category: 'Groceries', amount: -31.81, merchant: 'Citarella' })];
  const { kept, skipped } = withoutAlreadyCanonical(docs, canonical);
  assert.equal(skipped, 0);
  assert.equal(kept.length, 1, 'a transaction we do not already hold must still be imported');
});

test('required: a doc carrying a REAL monarch:<id> is never skipped — upsert updates it by key', () => {
  const fp = transactionFingerprint({ day: '2026-08-01', category: 'Entertainment & Recreation', amount: -63.94, merchant: 'AXS', account: "Norman's Venture X" });
  const docs = [importedDoc({ externalId: 'monarch:250995871774673622', day: '2026-08-01', category: 'Entertainment & Recreation', amount: -63.94, merchant: 'AXS' })];
  const { kept, skipped } = withoutAlreadyCanonical(docs, new Set([fp]));
  assert.equal(skipped, 0);
  assert.equal(kept.length, 1);
});

test('required: with nothing stored canonically, every row imports (first-ever import unaffected)', () => {
  const docs = [
    importedDoc({ externalId: 'h1', day: '2026-08-01', category: 'Groceries', amount: -10, merchant: 'A' }),
    importedDoc({ externalId: 'h2', day: '2026-08-02', category: 'Groceries', amount: -20, merchant: 'B' }),
  ];
  assert.equal(withoutAlreadyCanonical(docs, new Set()).kept.length, 2);
  assert.equal(withoutAlreadyCanonical(docs, null).kept.length, 2);
});

test('required: the fingerprint is robust to merchant/account case and amount formatting', () => {
  const a = transactionFingerprint({ day: '2026-08-01', category: 'Rent', amount: -5695, merchant: 'Glenwood Management', account: 'Checking' });
  const b = transactionFingerprint({ day: '2026-08-01', category: 'Rent', amount: '-5695.00', merchant: 'glenwood management', account: 'checking' });
  assert.equal(a, b, 'the same real transaction must fingerprint identically across writers');
});

test('required: a different amount or day is NOT treated as the same transaction', () => {
  const base = { day: '2026-08-01', category: 'Rent', amount: -5695, merchant: 'Glenwood', account: 'Checking' };
  assert.notEqual(transactionFingerprint(base), transactionFingerprint({ ...base, amount: -5696 }));
  assert.notEqual(transactionFingerprint(base), transactionFingerprint({ ...base, day: '2026-08-02' }));
});
