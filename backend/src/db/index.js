// Single shared Postgres connection pool for NormOS.
const { Pool } = require('pg');

const connectionString =
  process.env.DATABASE_URL || 'postgres://normos:normos@localhost:5432/normos';

const pool = new Pool({
  connectionString,
  // Cap concurrent connections so one burst of slow requests (e.g. several
  // overlapping briefing builds, each running many queries) can't silently
  // exhaust Postgres's own connection limit — every request past the cap
  // queues for a free connection instead of the DB itself refusing new ones.
  max: Number(process.env.DB_POOL_MAX) || 20,
  // How long a query is allowed to run before Postgres kills it server-side.
  // Without this, one runaway query (a bad plan, a lock wait) can hold a
  // pool connection — and the request thread awaiting it — indefinitely.
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 30_000,
  // How long an idle connection sits in the pool before being closed.
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS) || 30_000,
  // How long to wait for a free connection before failing fast, once the
  // pool is at `max` — rather than a request hanging forever with no error.
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 10_000,
});

pool.on('error', (err) => {
  console.error('[db] unexpected pool error:', err.message);
});

/** Run a parameterized query. */
function query(text, params) {
  return pool.query(text, params);
}

/** Run a function inside a transaction, rolling back on error. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Lightweight readiness check used by the /api/health endpoint. */
async function ping() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

module.exports = { pool, query, withTransaction, ping };
