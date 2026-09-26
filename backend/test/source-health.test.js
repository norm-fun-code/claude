// Shared source-staleness config + the single Monarch health signal
// (src/intelligence/source-health.js) — see the engineering review's #8.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceStaleness, describeDataGaps, getMonarchHealth } = require('../src/intelligence/source-health');

const HOUR = 3_600_000;
const hoursAgo = (h) => new Date(Date.now() - h * HOUR).toISOString();

test('sourceStaleness: fresh when within threshold', () => {
  const s = sourceStaleness({ id: 'monarch_mcp_sync', last_sync_at: hoursAgo(1) });
  assert.equal(s.isStale, false);
  assert.equal(s.thresholdHours, 26);
});

test('sourceStaleness: stale when past threshold', () => {
  const s = sourceStaleness({ id: 'monarch_mcp_sync', last_sync_at: hoursAgo(30) });
  assert.equal(s.isStale, true);
});

test('sourceStaleness: never-synced (null last_sync_at) counts as stale', () => {
  const s = sourceStaleness({ id: 'monarch', last_sync_at: null });
  assert.equal(s.isStale, true);
  assert.equal(s.hoursAgo, null);
});

test('sourceStaleness: unknown source id falls back to the default threshold', () => {
  const s = sourceStaleness({ id: 'some_new_connector', last_sync_at: hoursAgo(1) });
  assert.equal(s.thresholdHours, 72);
});

test('describeDataGaps: only reports sources with both a known threshold AND a prior sync', () => {
  const sources = [
    { id: 'monarch_mcp_sync', display_name: 'Monarch (MCP)', last_sync_at: hoursAgo(40) }, // stale
    { id: 'monarch', display_name: 'Monarch (CSV)', last_sync_at: hoursAgo(1) }, // fresh
    { id: 'unknown_thing', display_name: 'Unknown', last_sync_at: hoursAgo(1000) }, // no threshold configured
    { id: 'health', display_name: 'Apple Health', last_sync_at: null }, // never synced, skipped
  ];
  const gaps = describeDataGaps(sources);
  assert.equal(gaps.length, 1);
  assert.ok(gaps[0].includes('Monarch (MCP)'));
  assert.ok(gaps[0].includes('wealth/spending data'));
});

test('getMonarchHealth: unconfigured (no monarch rows at all) is not healthy', () => {
  const h = getMonarchHealth([{ id: 'health', last_sync_at: hoursAgo(1) }]);
  assert.equal(h.configured, false);
  assert.equal(h.healthy, false);
});

test('getMonarchHealth: healthy when the MCP path is stale but CSV/GraphQL-shared "monarch" row is fresh', () => {
  const h = getMonarchHealth([
    { id: 'monarch_mcp_sync', last_sync_at: hoursAgo(40) }, // stale (>26h)
    { id: 'monarch', last_sync_at: hoursAgo(1) }, // fresh (<48h)
  ]);
  assert.equal(h.configured, true);
  assert.equal(h.healthy, true, 'at least one fresh path means wealth data is current enough');
});

test('getMonarchHealth: unhealthy when BOTH tracked paths are stale', () => {
  const h = getMonarchHealth([
    { id: 'monarch_mcp_sync', last_sync_at: hoursAgo(40) },
    { id: 'monarch', last_sync_at: hoursAgo(60) },
  ]);
  assert.equal(h.healthy, false);
});

test('getMonarchHealth: works with only monarch_mcp_sync registered (monarch_api fallback never gets its own row)', () => {
  const h = getMonarchHealth([{ id: 'monarch_mcp_sync', last_sync_at: hoursAgo(1) }]);
  assert.equal(h.configured, true);
  assert.equal(h.healthy, true);
  assert.equal(h.rows.length, 1);
});

// --- wealthSyncAlert -----------------------------------------------------
// Reported: the morning brief nagged for months that "Monarch MCP sync is
// failing … transactions/income keep flowing via the backup sync" about an MCP
// the user had already retired. Both halves were wrong — see wealthSyncAlert's
// own comment. These pin the corrected behavior.
const { wealthSyncAlert } = require('../src/intelligence/source-health');

test('wealthSyncAlert: silent when the row is healthy', () => {
  assert.equal(wealthSyncAlert({ id: 'monarch_mcp_sync', status: 'active', last_sync_at: hoursAgo(1) }), null);
});

test('wealthSyncAlert: silent on a failed run that still has fresh data', () => {
  // THE nag. markSync does not advance last_sync_at on failure, so a fresh
  // timestamp means a successful run already landed today's numbers and this
  // failure changed nothing the user can act on before breakfast.
  assert.equal(
    wealthSyncAlert({ id: 'monarch_mcp_sync', status: 'error', last_error: 'Request failed with status code 502', last_sync_at: hoursAgo(3) }),
    null
  );
});

test('wealthSyncAlert: fires once the data actually goes stale', () => {
  const a = wealthSyncAlert({ id: 'monarch_mcp_sync', status: 'error', last_error: 'Request failed with status code 502', last_sync_at: hoursAgo(30) });
  assert.ok(a, 'a failing sync with no recent success is worth surfacing');
  assert.equal(a.severity, 'warn');
  assert.equal(a.source, 'monarch_mcp_sync');
  assert.match(a.message, /Request failed with status code 502/, 'reports the real error');
  assert.match(a.message, /last successful sync 30h ago/);
});

test('wealthSyncAlert: never blames MCP, never vouches for the backup', () => {
  // The two specific defects. The connector catches MCP failures and falls back,
  // so an error here came from the FALLBACK — naming MCP points at the one thing
  // that cannot be the cause, and promising the backup is fine is false exactly
  // when this fires, because the backup is what threw.
  const a = wealthSyncAlert({ id: 'monarch_mcp_sync', status: 'error', last_error: 'Request failed with status code 502', last_sync_at: hoursAgo(30) });
  assert.doesNotMatch(a.message, /MCP/i);
  assert.doesNotMatch(a.message, /backup sync/i);
  assert.doesNotMatch(a.message, /keep flowing/i);
  assert.doesNotMatch(a.message, /budget-vs-spending/i);
});

test('wealthSyncAlert: escalates to high when it has been failing for days', () => {
  const a = wealthSyncAlert({ id: 'monarch_mcp_sync', status: 'error', last_error: 'boom', last_sync_at: hoursAgo(120) });
  assert.equal(a.severity, 'high');
});

test('wealthSyncAlert: a never-successful sync is high severity and says so', () => {
  const a = wealthSyncAlert({ id: 'monarch_mcp_sync', status: 'error', last_error: 'boom', last_sync_at: null });
  assert.equal(a.severity, 'high');
  assert.match(a.message, /never completed a successful run/);
});

test('wealthSyncAlert: survives a missing error string rather than printing undefined', () => {
  const a = wealthSyncAlert({ id: 'monarch_mcp_sync', status: 'error', last_error: null, last_sync_at: hoursAgo(30) });
  assert.match(a.message, /unknown error/);
  assert.doesNotMatch(a.message, /undefined|null/);
});

test('wealthSyncAlert: tolerates a missing row', () => {
  assert.equal(wealthSyncAlert(null), null);
  assert.equal(wealthSyncAlert(undefined), null);
});
