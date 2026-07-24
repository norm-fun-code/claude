#!/usr/bin/env node
// One-time, safe repair for context_assertions rows compiled BEFORE the
// episodic-lifecycle fix existed (intelligence/context-compiler.js's
// resolveTemporalWindow duration/end-date extraction +
// intelligence/context-resolver.js's isForwardEpisodic/isTemporallyEligible)
// — a forward-looking episodic assertion (a stated future plan/ongoing
// state: a fast, a trip, an illness) with NO bounded effective_end, e.g.
// "25 hour fast starting tonight" compiled before this fix could keep
// reading as CURRENT indefinitely.
//
// NOT run automatically on server boot (Production Safety Gate, audit
// recommendation #1: a container restart must never silently mutate user
// data) — an operator runs this deliberately, once, after deploying the
// lifecycle fix:
//   node scripts/repair-unbounded-episodic-assertions.js
//
// Two-part behavior, per the fix's own contract:
//   1. RECONSTRUCT: where the assertion's own raw_text clearly states a
//      duration ("25 hour fast") or an end bound ("through tomorrow"), set
//      effective_end deterministically from that text + recorded_at (see
//      intelligence/episodic-repair.js — the exact same extraction logic
//      the live compiler now applies going forward, re-run here against
//      already-persisted text).
//   2. EXCLUDE (no data change needed): everything else is ALREADY
//      correctly excluded from current-state projections at READ time by
//      context-resolver.js's isTemporallyEligible/isForwardEpisodic (a
//      forward-episodic assertion with no effective_end never reads as
//      current) — this script does not delete or retire these rows; their
//      history is preserved exactly as the fix requires ("retain it
//      historically but exclude it from current projections").
//
// Idempotent: a row already repaired (effective_end no longer null) no
// longer matches the WHERE clause on a second run.
require('dotenv').config();
const { pool, query } = require('../src/db');
const { reconstructEffectiveEnd } = require('../src/intelligence/episodic-repair');

const TZ = process.env.TZ || 'America/New_York';

async function main() {
  const { rows } = await query(
    `SELECT id, raw_text, effective_start, recorded_at
       FROM context_assertions
      WHERE retired_at IS NULL
        AND assertion_type IN ('event', 'state', 'plan')
        AND event_status IN ('planned', 'ongoing')
        AND effective_end IS NULL
        AND effective_start IS NOT NULL`
  );

  if (!rows.length) {
    console.log('No unbounded episodic assertions found — nothing to repair.');
    return;
  }

  let reconstructed = 0;
  let leftExcluded = 0;
  for (const row of rows) {
    const newEnd = reconstructEffectiveEnd({
      rawText: row.raw_text, effectiveStart: row.effective_start, recordedAt: row.recorded_at, tz: TZ,
    });
    if (newEnd) {
      await query(`UPDATE context_assertions SET effective_end = $1 WHERE id = $2`, [newEnd.toISOString(), row.id]);
      reconstructed++;
      // Never log raw_text content — safe metadata only (id, the
      // reconstructed bound), matching every other log line in this layer.
      console.log(`  reconstructed effective_end for ${row.id} -> ${newEnd.toISOString()}`);
    } else {
      leftExcluded++;
    }
  }

  console.log(
    `Repair complete: ${rows.length} unbounded episodic assertion(s) found — `
    + `${reconstructed} reconstructed from their own text, ${leftExcluded} left as-is `
    + `(already correctly excluded from current-state projections at read time; history preserved).`
  );
}

main()
  .catch((err) => {
    console.error('repair-unbounded-episodic-assertions failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
