// Seed NormOS with ~90 days of realistic, *correlated* synthetic data so the
// whole brain can be exercised end-to-end (and so you can see the app work
// before wiring real connectors). Deterministic (seeded RNG) for reproducibility.
//
//   npm run seed            # idempotent: clears prior 'seed' data, re-inserts
//
// Intentional structure the intelligence layer should discover:
//   • last night's sleep -> today's focus / mood        (lag-1 correlation)
//   • sleep -> HRV                                       (same-day correlation)
//   • sleep is drifting down over the last two weeks     (worsening trend -> nudge)
//   • net worth trending up but short of an ambitious goal (at-risk forecast)
require('dotenv').config();
const { pool, query } = require('./index');
const { insertMetrics } = require('../store/metrics');

const SOURCE = 'seed';
const DAYS = 90;

// Tiny seeded PRNG (mulberry32) so runs are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayTs(daysAgo) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function build() {
  const rand = rng(42);
  const noise = (s) => (rand() - 0.5) * 2 * s;
  const rows = [];
  const add = (ts, domain, metric, value, unit) =>
    rows.push({ ts, domain, metric, value: Math.round(value * 100) / 100, unit, source: SOURCE });

  const sleepSeries = [];
  for (let i = 0; i < DAYS; i++) {
    const daysAgo = DAYS - 1 - i;
    const ts = dayTs(daysAgo);

    // Sleep: gentle weekly rhythm, with a downward drift in the final 14 days.
    const drift = daysAgo < 14 ? -(14 - daysAgo) * 0.06 : 0;
    const sleep = clamp(7.2 + 0.6 * Math.sin(i / 5) + drift + noise(0.4), 4.5, 9.5);
    sleepSeries[i] = sleep;
    const prevSleep = i > 0 ? sleepSeries[i - 1] : sleep;

    // Outcomes driven by sleep (prev night for focus/mood — a lag-1 effect).
    const hrv = clamp(46 + 7 * (sleep - 7.2) + noise(3), 20, 90);
    const focus = clamp(6.2 + 1.4 * (prevSleep - 7.2) + noise(0.8), 1, 10);
    const mood = clamp(6.4 + 1.1 * (prevSleep - 7.2) + noise(0.9), 1, 10);
    const energy = clamp(6.0 + 1.2 * (sleep - 7.2) + noise(0.9), 1, 10);
    const restingHr = clamp(60 - 3 * (sleep - 7.2) + noise(2), 45, 80);
    const steps = clamp(8200 + noise(2500), 1500, 20000);
    const meetings = Math.round(clamp(3 + noise(3), 0, 8));

    add(ts, 'health', 'sleep_hours', sleep, 'hours');
    add(ts, 'health', 'hrv', hrv, 'ms');
    add(ts, 'health', 'resting_hr', restingHr, 'bpm');
    add(ts, 'health', 'steps', steps, 'count');
    add(ts, 'wellbeing', 'focus', focus, 'score');
    add(ts, 'wellbeing', 'mood', mood, 'score');
    add(ts, 'wellbeing', 'energy', energy, 'score');
    add(ts, 'productivity', 'meetings', meetings, 'count');

    // Wealth: net worth trending up ~$140/day; daily spending; weekly income.
    add(ts, 'wealth', 'net_worth', 200000 + i * 140 + noise(800), 'usd');
    add(ts, 'wealth', 'spending', clamp(85 + noise(60), 0, 400), 'usd');
    if (daysAgo % 14 === 0) add(ts, 'wealth', 'income', 3200 + noise(200), 'usd');
  }
  return rows;
}

const GOALS = [
  {
    domain: 'wealth', metric: 'net_worth', title: 'Hit $260k net worth',
    target_value: 260000, baseline_value: 200000, unit: 'usd', daysOut: 120,
  },
  {
    domain: 'health', metric: 'hrv', title: 'Raise HRV to 60ms',
    target_value: 60, baseline_value: 46, unit: 'ms', daysOut: 75,
  },
  {
    domain: 'wellbeing', metric: 'focus', title: 'Average 8/10 focus',
    target_value: 8, baseline_value: 6.2, unit: 'score', daysOut: 60,
  },
];

async function seed() {
  // Idempotent: wipe anything previously seeded.
  await query(`DELETE FROM metrics WHERE source = $1`, [SOURCE]);
  await query(`DELETE FROM goals WHERE metadata->>'seed' = 'true'`);
  await query(
    `INSERT INTO sources (id, domain, display_name, status)
     VALUES ($1, 'system', 'Seed (demo data)', 'active')
     ON CONFLICT (id) DO NOTHING`,
    [SOURCE]
  );

  const rows = build();
  const written = await insertMetrics(rows);

  for (const g of GOALS) {
    const target = new Date();
    target.setUTCDate(target.getUTCDate() + g.daysOut);
    await query(
      `INSERT INTO goals (domain, title, metric, target_value, baseline_value, unit, target_date, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'{"seed":"true"}')`,
      [g.domain, g.title, g.metric, g.target_value, g.baseline_value, g.unit, target.toISOString().slice(0, 10)]
    );
  }

  return { metrics: written, goals: GOALS.length, days: DAYS };
}

module.exports = { seed, build };

if (require.main === module) {
  seed()
    .then((s) => console.log(`Seeded ${s.metrics} metrics over ${s.days} days + ${s.goals} goals.`))
    .catch((err) => { console.error('Seed failed:', err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
