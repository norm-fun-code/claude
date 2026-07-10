// Regression test: today's notification-load merge (see notify-evening-reminder
// tests) left a stray console.log in scheduler.js's startJobs() referencing
// four variables that had just been deleted (checkinEveningHour/Minute,
// habitsHour/Minute). node --check and `require()` both passed — the bug only
// throws once startJobs() actually RUNS, which no test exercised. The throw
// happened to land after every scheduleDaily/scheduleWeekly call had already
// registered its timer, and startJobs() runs inside a fire-and-forget
// tryBecomeLeader().then(...) with no .catch(), so it became a silent
// unhandledRejection instead of a visible crash — nothing in CI or the health
// check caught it. This spawns start() in a real child process (scheduleDaily
// sets ~24h setTimeouts with no .unref(), so running it in-process would hang
// the test) and fails if anything throws during job registration.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const CHILD_SCRIPT = `
process.on('unhandledRejection', (e) => console.error('UNHANDLED_REJECTION_MARKER', (e && e.stack) || e));
process.on('uncaughtException', (e) => console.error('UNCAUGHT_EXCEPTION_MARKER', (e && e.stack) || e));
require('./src/scheduler').start();
setTimeout(() => {}, 3000);
`;

test("scheduler.start() registers every job without an uncaught exception or unhandled rejection", () => {
  const result = spawnSync(process.execPath, ['-e', CHILD_SCRIPT], {
    cwd: path.join(__dirname, '../..'),
    env: { ...process.env, ENABLE_SCHEDULER: 'true' },
    timeout: 4000,
    encoding: 'utf8',
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  assert.ok(
    !/UNCAUGHT_EXCEPTION_MARKER|UNHANDLED_REJECTION_MARKER/.test(output),
    `scheduler.start() threw during job registration:\n${output}`
  );
  assert.match(
    output,
    /\[scheduler\] enabled/,
    `expected confirmation that jobs were registered, got:\n${output}`
  );
});
