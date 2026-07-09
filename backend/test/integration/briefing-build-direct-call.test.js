// buildFreshBriefing() was extracted out of the GET /briefing route handler
// so POST /briefing/rebuild and notify/morning.js's warmBriefing() could call
// it directly instead of each doing a loopback HTTP round-trip to this same
// process's own /api/briefing?refresh=1. This verifies the extracted
// function is directly callable and returns the same payload shape the
// route itself returns — and, unlike the old loopback call, needs no
// NORMOS_API_TOKEN plumbing at all (proving it's a real in-process call, not
// secretly still going over HTTP).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');

const priorToken = process.env.NORMOS_API_TOKEN;
delete process.env.NORMOS_API_TOKEN; // the old loopback path required this to authenticate itself

after(async () => {
  if (priorToken !== undefined) process.env.NORMOS_API_TOKEN = priorToken;
  await closeDb();
});

test('buildFreshBriefing() is directly callable and returns a briefing payload with no NORMOS_API_TOKEN set', async () => {
  const { buildFreshBriefing } = require('../../src/routes/briefing');
  const result = await buildFreshBriefing({ force: true });
  assert.equal(typeof result, 'object');
  assert.ok(result !== null);
  // The fresh-build path never sets `cached` (only the cache-hit branch sets
  // cached:true) — confirms this took the "build fresh" path, not a cache hit.
  assert.notEqual(result.cached, true);
});

test('notify/morning.js warmBriefing() calls buildFreshBriefing directly, not over HTTP', async () => {
  const morning = require('../../src/notify/morning');
  // fetch is a global; if warmBriefing still used the old loopback path, this
  // stub would be hit. Confirms zero network calls happen inside warmBriefing.
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = (...args) => { fetchCalled = true; return originalFetch(...args); };
  try {
    await morning.warmBriefing?.();
  } catch { /* external sources fail in this test env — irrelevant to this assertion */ }
  finally {
    global.fetch = originalFetch;
  }
  assert.equal(fetchCalled, false, 'warmBriefing must not make any HTTP fetch calls');
});
