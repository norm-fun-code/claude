#!/usr/bin/env node
// One-time seed of Eight Sleep baseline averages.
// Seeds historical metric rows so the self-model and morning brief have
// meaningful baselines to compare tonight's data against.
//
// Strategy:
//   Days 1-7:   7-day averages
//   Days 8-30:  30-day averages
//   Days 31-180: 6-month averages
//
// Source: 'eight_sleep_baseline' — distinct from real nightly entries so
// the analyze engine can weight them appropriately.
// Safe to re-run — upserts on (ts, domain, metric, source).

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../src/db');
const metricsStore = require('../src/store/metrics');

const TZ     = process.env.TZ || 'America/New_York';
const SOURCE = 'eight_sleep_baseline';
const DOMAIN = 'health';

// ---- Your baseline averages ----
const B7 = {
  hrv:              38,
  resting_hr:       56,
  sleep_hours:      7 + 25/60,
  deep_sleep_hours: 1 + 14/60,
  rem_sleep_hours:  1 + 56/60,
  sleep_score:      84,
};
const B30 = {
  hrv:              39,
  resting_hr:       55,
  sleep_hours:      7 + 45/60,
  deep_sleep_hours: 1 + 14/60,
  rem_sleep_hours:  1 + 55/60,
  sleep_score:      87,
};
const B180 = {
  hrv:              41,
  resting_hr:       55,
  sleep_hours:      7 + 56/60,
  deep_sleep_hours: 1 + 25/60,
  rem_sleep_hours:  1 + 55/60,
  sleep_score:      87,
};

function anchorForDaysAgo(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  // Noon UTC of the local date in TZ
  const ymd = d.toLocaleDateString('en-CA', { timeZone: TZ });
  return new Date(`${ymd}T12:00:00Z`);
}

function baselineForDay(daysAgo) {
  if (daysAgo <= 7)  return B7;
  if (daysAgo <= 30) return B30;
  return B180;
}

async function run() {
  const METRICS = ['hrv', 'resting_hr', 'sleep_hours', 'deep_sleep_hours', 'rem_sleep_hours', 'sleep_score'];
  const rows = [];

  for (let daysAgo = 1; daysAgo <= 180; daysAgo++) {
    const bl  = baselineForDay(daysAgo);
    const ts  = anchorForDaysAgo(daysAgo);
    for (const m of METRICS) {
      if (bl[m] == null) continue;
      rows.push({ ts, domain: DOMAIN, metric: m, value: +bl[m].toFixed(3), source: SOURCE });
    }
  }

  console.log(`Seeding ${rows.length} baseline rows (180 nights × ${METRICS.length} metrics)…`);
  const written = await metricsStore.insertMetrics(rows);
  console.log(`Done — ${written} rows written.`);
  console.log('\nBaselines seeded:');
  console.log('  7d:  HRV 38ms · RHR 56bpm · Sleep 7h25m · Deep 1h14m · REM 1h56m · Score 84');
  console.log(' 30d:  HRV 39ms · RHR 55bpm · Sleep 7h45m · Deep 1h14m · REM 1h55m · Score 87');
  console.log('180d:  HRV 41ms · RHR 55bpm · Sleep 7h56m · Deep 1h25m · REM 1h55m · Score 87');
  await pool.end();
}

run().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exitCode = 1;
  pool.end();
});
