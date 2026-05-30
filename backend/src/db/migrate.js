// Minimal forward-only migration runner. Applies every *.sql file in
// ./migrations (sorted by name) exactly once, tracked in schema_migrations.
//
//   node src/db/migrate.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool, withTransaction } = require('./index');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedSet() {
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  return new Set(rows.map((r) => r.name));
}

async function run() {
  await ensureTable();
  const applied = await appliedSet();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    process.stdout.write(`Applying ${file} ... `);
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    console.log('done');
    count++;
  }

  console.log(count === 0 ? 'Already up to date.' : `Applied ${count} migration(s).`);
  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
