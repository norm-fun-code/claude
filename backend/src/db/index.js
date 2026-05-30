// Single shared Postgres connection pool for NormOS.
const { Pool } = require('pg');

const connectionString =
  process.env.DATABASE_URL || 'postgres://normos:normos@localhost:5432/normos';

const pool = new Pool({ connectionString });

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
