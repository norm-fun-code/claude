// The array-form ingest path used the client-supplied per-row `ts` verbatim
// instead of anchoring it to a stable per-day timestamp like the flat-object
// path does — two refreshes for the same logical day (each with a slightly
// different raw HealthKit sample ts) would miss the (ts, domain, metric,
// source) upsert conflict target and both persist as separate rows. This is
// the same duplication root-caused by the four dedupe/rededupe migrations
// (010, 011, 018, 019) — this closes the gap in the writer itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapHealthPayload } = require('../src/ingest/health');

const TZ = 'America/New_York';

test('array-form rows with a client-supplied ts are anchored to noon UTC of their own local day', () => {
  const rows = mapHealthPayload(
    [{ metric: 'steps', value: 5000, ts: '2026-07-08T23:30:00-04:00' }],
    { tz: TZ }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ts.toISOString(), '2026-07-08T12:00:00.000Z');
});

test('two refreshes with different raw ts on the same local day anchor to the SAME ts (upsert collides)', () => {
  const first = mapHealthPayload(
    [{ metric: 'steps', value: 4000, ts: '2026-07-08T10:00:00.123-04:00' }],
    { tz: TZ }
  );
  const second = mapHealthPayload(
    [{ metric: 'steps', value: 5200, ts: '2026-07-08T18:42:07.998-04:00' }],
    { tz: TZ }
  );
  assert.equal(first[0].ts.toISOString(), second[0].ts.toISOString());
});

test('an evening-ET sample near UTC midnight still anchors to the correct (Eastern) local day', () => {
  // 8pm ET on 2026-07-08 is already 2026-07-09 in UTC — the exact scenario
  // migration 019 was written to repair after the fact.
  const rows = mapHealthPayload(
    [{ metric: 'steps', value: 3000, ts: '2026-07-08T20:00:00-04:00' }],
    { tz: TZ }
  );
  assert.equal(rows[0].ts.toISOString(), '2026-07-08T12:00:00.000Z');
});

test('array-form rows with NO row-level ts fall back to the request-level anchor (unchanged behavior)', () => {
  const rows = mapHealthPayload(
    [{ metric: 'steps', value: 1000 }],
    { tz: TZ }
  );
  // No explicit top-level ts either — falls all the way back to "now" in tz,
  // which dayAnchorTs already anchors correctly. Just confirm it's noon UTC.
  assert.equal(rows[0].ts.toISOString().endsWith('T12:00:00.000Z'), true);
});

test('a backfilled historical sample (row-level ts) anchors to ITS OWN day, not the request day', () => {
  const rows = mapHealthPayload(
    [{ metric: 'steps', value: 9000, ts: '2026-06-01T09:00:00-04:00' }],
    { tz: TZ }
  );
  assert.equal(rows[0].ts.toISOString(), '2026-06-01T12:00:00.000Z');
});
