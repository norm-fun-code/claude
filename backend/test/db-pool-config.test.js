// The Staff+ review flagged an unbounded pool + no statement_timeout as the
// highest safety-per-line risk in the repo: one slow LLM/Monarch call could
// silently exhaust connections into cascading 500s. This locks in that the
// pool actually applies bounded defaults (and honors env overrides) without
// requiring a live Postgres connection — `new Pool()` doesn't connect eagerly.
const test = require('node:test');
const assert = require('node:assert/strict');

test('db pool applies bounded defaults for max/timeouts when no env override is set', () => {
  delete process.env.DB_POOL_MAX;
  delete process.env.DB_STATEMENT_TIMEOUT_MS;
  delete process.env.DB_IDLE_TIMEOUT_MS;
  delete process.env.DB_CONNECT_TIMEOUT_MS;
  delete require.cache[require.resolve('../src/db')];
  const db = require('../src/db');
  assert.equal(db.pool.options.max, 20);
  assert.equal(db.pool.options.statement_timeout, 30_000);
  assert.equal(db.pool.options.idleTimeoutMillis, 30_000);
  assert.equal(db.pool.options.connectionTimeoutMillis, 10_000);
});

test('db pool honors env overrides for max/timeouts', () => {
  process.env.DB_POOL_MAX = '7';
  process.env.DB_STATEMENT_TIMEOUT_MS = '12345';
  process.env.DB_IDLE_TIMEOUT_MS = '6789';
  process.env.DB_CONNECT_TIMEOUT_MS = '4321';
  delete require.cache[require.resolve('../src/db')];
  const db = require('../src/db');
  assert.equal(db.pool.options.max, 7);
  assert.equal(db.pool.options.statement_timeout, 12345);
  assert.equal(db.pool.options.idleTimeoutMillis, 6789);
  assert.equal(db.pool.options.connectionTimeoutMillis, 4321);
  delete process.env.DB_POOL_MAX;
  delete process.env.DB_STATEMENT_TIMEOUT_MS;
  delete process.env.DB_IDLE_TIMEOUT_MS;
  delete process.env.DB_CONNECT_TIMEOUT_MS;
});
