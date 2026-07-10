// Root cause of "the scheduler mysteriously stopped — nothing fired at all":
// leader election was single-shot. During a deploy Railway briefly runs the
// old and new containers together; a freshly-booted instance that lost the
// race for the advisory lock gave up FOREVER ("not registering jobs here").
// Seconds later the old container died, the lock freed, and nobody was left
// running the scheduler until the next deploy. This test holds the lock from
// a rival session (standing in for the not-yet-dead old container), starts a
// real scheduler process, confirms it stays dormant-but-retrying, then frees
// the lock and confirms the follower promotes itself and registers jobs.
//
// Runs the scheduler in a CHILD process because startJobs() arms long-lived
// setTimeout handles that would otherwise keep the test runner's event loop
// alive and hang it (same reason scheduler-start-no-crash.test.js spawns one).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { closeDb } = require('./helpers');
const db = require('../../src/db');

const LEADER_LOCK_ID = 727001;

const CHILD_SCRIPT = `
process.env.ENABLE_SCHEDULER = 'true';
process.env.SCHEDULER_LEADER_RETRY_MS = '250';
const scheduler = require('./src/scheduler');
scheduler.start();
setInterval(() => console.log('STATE ' + JSON.stringify(scheduler.schedulerState())), 150);
setTimeout(() => {}, 10000);
`;

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('a follower that loses the election retries and promotes itself once the lock frees', async () => {
  // Rival session (a separate pooled client = separate PG session) holds the
  // lock — this is the still-alive previous container during a deploy overlap.
  const rival = await db.pool.connect();
  const acq = await rival.query('SELECT pg_try_advisory_lock($1) AS acquired', [LEADER_LOCK_ID]);
  assert.equal(acq.rows[0].acquired, true, 'rival should hold the lock first');

  const states = [];
  const child = spawn(process.execPath, ['-e', CHILD_SCRIPT], {
    cwd: path.join(__dirname, '../..'),
    env: { ...process.env },
    encoding: 'utf8',
  });
  child.stdout.on('data', (buf) => {
    for (const line of String(buf).split('\n')) {
      const m = line.match(/^STATE (.+)$/);
      if (m) { try { states.push(JSON.parse(m[1])); } catch { /* partial line */ } }
    }
  });

  try {
    // Give the child time to boot and lose the election a few times.
    await delay(1200);
    const heldStates = states.slice();
    assert.ok(heldStates.length > 0, 'child should have reported state while the lock was held');
    const last = heldStates[heldStates.length - 1];
    assert.equal(last.jobsStarted, false, 'must NOT register jobs while another instance holds the lock');
    assert.equal(last.awaitingLeadership, true, 'must be actively retrying, not given up');

    // Old container dies → lock frees.
    await rival.query('SELECT pg_advisory_unlock($1)', [LEADER_LOCK_ID]);
    rival.release();

    // Within a couple retry intervals the follower must promote itself.
    await delay(1500);
    const promoted = states[states.length - 1];
    assert.equal(promoted.isLeader, true, 'follower should acquire the lock once it frees');
    assert.equal(promoted.jobsStarted, true, 'follower should register jobs after promotion');
    assert.equal(promoted.awaitingLeadership, false, 'should stop retrying once promoted');
  } finally {
    child.kill('SIGKILL');
    try { rival.release(); } catch { /* already released */ }
  }
});

test.after(async () => {
  // The child held the real advisory lock in its own session; killing it ends
  // that session and frees the lock. Nothing to unlock here — just close the pool.
  await closeDb();
});
