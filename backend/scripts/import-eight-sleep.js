#!/usr/bin/env node
// One-time importer for Eight Sleep exported data (sleep_nights.json).
//
// Usage:
//   node backend/scripts/import-eight-sleep.js /path/to/sleep_nights.json
//
// Or from backend/ directory:
//   node scripts/import-eight-sleep.js ~/Downloads/sleep_nights.json
//
// What it does:
//   - Parses each sleep session: stages + HRV/HR/respiratory timeseries
//   - Computes per-night: sleep_hours, deep_sleep_hours, rem_sleep_hours,
//     hrv (mean), resting_hr (mean), respiratory_rate (mean), sleep_score
//   - Anchors each night to noon UTC of the wake-up date (same as Apple Health)
//   - Inserts with source='eight_sleep' — won't overwrite Apple Watch rows
//   - Already-existing rows are upserted (safe to re-run)

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');
const { pool } = require('../src/db');
const metricsStore = require('../src/store/metrics');
const { dayAnchorTs } = require('../src/util/date');

const TZ     = process.env.TZ || 'America/New_York';
const SOURCE = 'eight_sleep';
const DOMAIN = 'health';

// Stages counted as real sleep (not in bed but awake)
const SLEEP_STAGES = new Set(['light', 'deep', 'rem']);

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function parseSession(session) {
  const { ts, stages = [], timeseries = {} } = session;
  if (!ts || !Array.isArray(stages)) return null;

  // Total stage seconds
  let sleepSec = 0, deepSec = 0, remSec = 0;
  let totalSec = 0;
  for (const { stage, duration } of stages) {
    const d = Number(duration) || 0;
    totalSec += d;
    if (SLEEP_STAGES.has(stage)) sleepSec += d;
    if (stage === 'deep') deepSec += d;
    if (stage === 'rem')  remSec  += d;
  }

  // Wake-up time = session start + total stage duration → local date = sleep date
  const wakeTs = new Date((ts + totalSec) * 1000);
  // Anchor to noon UTC of the local wake-up date (consistent with Apple Health)
  const anchor = dayAnchorTs(TZ, wakeTs);

  // Timeseries: extract numeric values
  const tsVals = (key) =>
    (timeseries[key] || []).map(([, v]) => Number(v)).filter(Number.isFinite);

  const hrvVals  = tsVals('hrv');
  const hrVals   = tsVals('heartRate');
  const rrVals   = tsVals('respiratoryRate');

  const hrv  = mean(hrvVals);
  const rhr  = mean(hrVals);
  const rr   = mean(rrVals);

  const sleepHours = sleepSec / 3600;
  const deepHours  = deepSec  / 3600;
  const remHours   = remSec   / 3600;

  // Simple sleep score from stages + HRV
  let score = 50;
  if (sleepHours >= 7)   score += 15;
  if (sleepHours >= 8)   score += 10;
  if (sleepHours < 6)    score -= 15;
  if (deepHours  >= 1.5) score += 10;
  if (deepHours  >= 2)   score += 5;
  if (remHours   >= 1.5) score += 10;
  if (hrv != null && hrv >= 50) score += 5;
  if (hrv != null && hrv < 30)  score -= 10;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const metrics = [];
  const push = (metric, value, bounds) => {
    if (value == null || !Number.isFinite(value)) return;
    if (bounds && (value < bounds[0] || value > bounds[1])) return;
    metrics.push({ ts: anchor, domain: DOMAIN, metric, value, source: SOURCE });
  };

  push('sleep_hours',       sleepHours, [0.5, 16]);
  push('deep_sleep_hours',  deepHours,  [0,   14]);
  push('rem_sleep_hours',   remHours,   [0,   14]);
  push('sleep_score',       score,      [0,  100]);
  push('hrv',               hrv,        [2,  300]);
  push('resting_hr',        rhr,        [25, 130]);
  push('respiratory_rate',  rr,         [4,   50]);

  return { date: anchor.toISOString().slice(0, 10), metrics };
}

async function run() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/import-eight-sleep.js <path/to/sleep_nights.json>');
    process.exit(1);
  }

  const raw = fs.readFileSync(path.resolve(file), 'utf8');
  const { sessions } = JSON.parse(raw);
  if (!Array.isArray(sessions)) {
    console.error('Expected { sessions: [...] } in JSON');
    process.exit(1);
  }

  console.log(`Parsing ${sessions.length} Eight Sleep sessions…`);

  let written = 0, skipped = 0;
  for (const session of sessions) {
    const parsed = parseSession(session);
    if (!parsed) { skipped++; continue; }
    try {
      const n = await metricsStore.insertMetrics(parsed.metrics);
      written += n;
      process.stdout.write('.');
    } catch (err) {
      console.error(`\nFailed for ${parsed.date}: ${err.message}`);
      skipped++;
    }
  }

  console.log(`\n\nDone. ${written} metric rows written, ${skipped} sessions skipped.`);
  console.log('Run POST /api/analyze next to generate findings from the new data.');
  await pool.end();
}

run().catch((err) => {
  console.error('Import failed:', err.message);
  process.exitCode = 1;
  pool.end();
});
