#!/usr/bin/env node
// Manual, admin-run repair for the recommendation ledger — NOT run
// automatically on server boot (Production Safety Gate, audit
// recommendation #1: a container restart must never silently mutate user
// data). Collapses near-duplicate PENDING recommendations (same dedup_key,
// or for older rows with none, a title that differs only by the numbers)
// down to the newest — never touches a row the user has already rated.
// Unlike the one-time cleanups in migrations 052-058, this one CAN
// legitimately need to run again (new duplicates can appear any time
// analyze() generates fresh recommendations), so it stays a standalone
// script an operator runs deliberately rather than a one-shot migration.
// Direct DB access only (no HTTP surface, no token needed) — run it on/
// against the same DATABASE_URL the server uses:
//   node scripts/repair-recommendations.js
require('dotenv').config();
const recommendationsStore = require('../src/store/recommendations');
const { pool } = require('../src/db');

(async () => {
  const n = await recommendationsStore.dedupePending();
  console.log(n > 0 ? `Collapsed ${n} duplicate recommendation(s).` : 'No duplicate recommendations found.');
})()
  .catch((err) => {
    console.error('repair-recommendations failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
