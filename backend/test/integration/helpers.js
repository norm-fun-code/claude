// Shared setup for route/integration tests: a real Express app (src/app.js)
// wired against a REAL Postgres (DATABASE_URL) with fixed test tokens, so
// these exercise actual routing/middleware/DB behavior rather than mocks.
// Requires a migrated database — CI runs these after `npm run migrate`; for
// local runs, point DATABASE_URL at a migrated dev/test DB.
process.env.NORMOS_API_TOKEN = process.env.NORMOS_API_TOKEN || 'test-app-token';
process.env.NORMOS_ADMIN_TOKEN = process.env.NORMOS_ADMIN_TOKEN || 'test-admin-token';

const { createApp } = require('../../src/app');

function buildTestApp(opts = {}) {
  return createApp({ bootTime: '2026-01-01T00:00:00.000Z', port: 3001, quiet: true, ...opts });
}

const APP_TOKEN = process.env.NORMOS_API_TOKEN;
const ADMIN_TOKEN = process.env.NORMOS_ADMIN_TOKEN;

function authHeader(token = APP_TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

// pg's Pool keeps its connections alive indefinitely — without closing it,
// `node --test` hangs after the last test completes. Each integration test
// file (its own process under the test runner) must call this once, in a
// top-level after() hook.
function closeDb() {
  return require('../../src/db').pool.end();
}

module.exports = { buildTestApp, authHeader, APP_TOKEN, ADMIN_TOKEN, closeDb };
