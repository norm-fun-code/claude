// Production Safety Gate (audit recommendation #1), item 3 — proves the
// actual `node server.js` entrypoint end-to-end: a migration failure must
// exit nonzero and NEVER call app.listen(). Spawns the real process (the
// only honest way to test a script entrypoint with top-level boot side
// effects, not a requirable module) against the real test Postgres, with a
// deliberately broken migration file planted first.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const REPO_ROOT = path.join(__dirname, '..', '..');

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

function runServer(port, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        NORMOS_API_TOKEN: process.env.NORMOS_API_TOKEN || 'test-app-token',
        NORMOS_ADMIN_TOKEN: process.env.NORMOS_ADMIN_TOKEN || 'test-admin-token',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => resolve({ code, stdout, stderr, timedOut: false }));
    // Safety net: if the process is still alive after 10s (e.g. it DID
    // start listening, which would be the failure mode this test guards
    // against), kill it and report that explicitly rather than hanging the
    // suite forever.
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, 10000);
    child.on('exit', () => clearTimeout(killer));
  });
}

test('node server.js: a migration failure exits nonzero and NEVER starts listening on the port', async () => {
  const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'normos-boot-migration-'));
  const brokenMigration = path.join(migrationsDir, '999_test_boot_never_listens.sql');
  fs.writeFileSync(brokenMigration, 'THIS IS NOT VALID SQL;;;');
  const port = await freePort();
  try {
    const result = await runServer(port, { NORMOS_MIGRATIONS_DIR: migrationsDir });
    assert.equal(result.timedOut, false, 'the process must exit on its own, not keep running (which would mean it started listening)');
    assert.equal(result.code, 1, `expected exit code 1, got ${result.code}. stderr:\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /NormOS backend running/, 'the "server is up" log line must never print on a failed migration');
    assert.match(result.stderr, /FATAL.*migration failed/i);
  } finally {
    fs.rmSync(migrationsDir, { recursive: true, force: true });
    const { pool } = require('../../src/db');
    await pool.query(`DELETE FROM schema_migrations WHERE name = '999_test_boot_never_listens.sql'`);
    await pool.end();
  }
});

test('node server.js: a HEALTHY migration boots normally and the port becomes reachable', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), NORMOS_API_TOKEN: process.env.NORMOS_API_TOKEN || 'test-app-token', NORMOS_ADMIN_TOKEN: process.env.NORMOS_ADMIN_TOKEN || 'test-admin-token' },
  });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  try {
    // Poll for the "server is up" log line rather than a fixed sleep.
    const deadline = Date.now() + 10000;
    while (!stdout.includes('NormOS backend running') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(stdout, /NormOS backend running/, 'expected a healthy boot to reach app.listen()');
    const res = await fetch(`http://localhost:${port}/api/health`);
    assert.equal(res.status, 200);
  } finally {
    child.kill('SIGKILL');
  }
});
