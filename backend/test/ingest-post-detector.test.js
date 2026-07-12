// P4 (phase one): wealth detection is now EVENT-DRIVEN off Monarch ingest, not
// only polled at 1pm/5pm. ingest/run.js runs a per-connector post-ingest
// detector; the monarch_mcp_sync detector fires the wealth watch only when the
// sync actually wrote metrics and didn't error. Delivery still routes through
// the Attention Policy (atomic since migration 045), so a post-ingest trigger
// racing the scheduled backstop can't double-notify.
const test = require('node:test');
const assert = require('node:assert/strict');
const wealthNudges = require('../src/intelligence/wealth-nudges');
const { POST_INGEST_DETECTORS } = require('../src/ingest/run');

const ORIG = wealthNudges.runWealthNudges;
let calls;
test.beforeEach(() => { calls = 0; wealthNudges.runWealthNudges = async () => { calls += 1; return { sent: 0 }; }; });
test.afterEach(() => { wealthNudges.runWealthNudges = ORIG; });

const monarch = POST_INGEST_DETECTORS.monarch_mcp_sync;

test('there is a post-ingest detector wired for monarch_mcp_sync', () => {
  assert.equal(typeof monarch, 'function');
});

test('a successful Monarch sync that wrote metrics triggers the wealth watch', async () => {
  monarch({ id: 'monarch_mcp_sync', metrics: 12, documents: 5 });
  await new Promise((r) => setImmediate(r)); // let the fire-and-forget run
  assert.equal(calls, 1, 'wealth detection runs immediately after a productive Monarch ingest');
});

test('a Monarch sync that wrote NO metrics does not trigger the wealth watch', async () => {
  monarch({ id: 'monarch_mcp_sync', metrics: 0, documents: 0 });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 0, 'no fresh wealth data -> no event-driven watch (the scheduled poll is the backstop)');
});

test('a Monarch sync that errored does not trigger the wealth watch', async () => {
  monarch({ id: 'monarch_mcp_sync', error: 'Monarch MCP paused' });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 0, 'a failed ingest must not fire a detector off partial/no data');
});
