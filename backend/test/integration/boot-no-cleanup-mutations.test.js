// Production Safety Gate (audit recommendation #1), item 5 — proves an
// ordinary server boot no longer mutates user-facing data (recommendations/
// findings) the way it used to (server.js ran several DELETE/repair queries
// on every restart). Those became one-time idempotent migrations
// (052-058) instead — this seeds rows shaped exactly like what those
// queries used to delete/reset, spawns a REAL `node server.js`, and proves
// the rows survive an ordinary boot untouched (since the migrations have
// already run once against this DB and are no-ops on every subsequent
// boot, and server.js itself no longer runs any such query at all).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const { pool } = require('../../src/db');
const recommendationsStore = require('../../src/store/recommendations');
const { closeDb } = require('./helpers');

const REPO_ROOT = path.join(__dirname, '..', '..');
const TEST_TAG = `boot-no-cleanup-${Date.now()}`;

test.after(async () => {
  // recordRecommendation() auto-creates a linked commitment as a side
  // effect — clean that up too, not just the recommendation row itself.
  await pool.query(`DELETE FROM commitments WHERE title LIKE $1`, [`%${TEST_TAG}%`]);
  await pool.query(`DELETE FROM recommendations WHERE title LIKE $1`, [`%${TEST_TAG}%`]);
  await closeDb();
});

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

test('a healthy `node server.js` boot never mutates the recommendation ledger — a row shaped exactly like the OLD boot-time cleanup target survives untouched', async () => {
  // Shaped exactly like migration 052's target: a "query step" title the
  // old server.js boot code used to DELETE unconditionally on every
  // restart. Un-rated (outcome_measured_at NULL) so it would also have
  // matched 058's WHERE clause if it were an energy/HRV title — using the
  // 052 shape specifically since that pattern is the simplest unconditional
  // DELETE (no EXISTS join, no other row needed to trigger it).
  const insertedId = await recommendationsStore.recordRecommendation({
    title: `Pull Jan–Jun spend for ${TEST_TAG}`,
    detail: 'test row shaped like a legacy query-step recommendation',
  });

  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), NORMOS_API_TOKEN: process.env.NORMOS_API_TOKEN || 'test-app-token', NORMOS_ADMIN_TOKEN: process.env.NORMOS_ADMIN_TOKEN || 'test-admin-token' },
  });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  try {
    const deadline = Date.now() + 10000;
    while (!stdout.includes('NormOS backend running') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(stdout, /NormOS backend running/, 'sanity: the boot must actually succeed for this test to mean anything');
  } finally {
    child.kill('SIGKILL');
  }

  const { rows: after } = await pool.query(`SELECT id FROM recommendations WHERE id = $1`, [insertedId]);
  assert.equal(after.length, 1, 'a normal server boot must NEVER delete a recommendation row — that mutation now lives only in the one-time migration, already applied to this DB, not in server.js itself');
});

test('server.js source contains no boot-time DELETE/UPDATE data-mutation queries', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
  assert.doesNotMatch(src, /DELETE FROM|UPDATE\s+\w+\s+SET/i, 'server.js must not contain any raw data-mutating SQL — cleanup belongs in migrations or an explicit admin-run script, never unconditional boot-time mutation');
});
