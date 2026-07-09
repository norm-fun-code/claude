// Event-driven anomaly watcher — the "NormOS noticed something" engine.
//
// The morning nudge runner (notify/run.js) is finding-driven and fires once a
// day, and it has NO builder for baseline anomalies — so a cratered HRV or a
// short night never reaches the phone unless you open the app. This closes that
// gap: on every health ingest, diff the just-written metrics against the user's
// OWN 30-day baseline and, if something deviates sharply in a direction worth
// caring about, push a single contextual message within the hour.
//
// Deliberately conservative so it never spams:
//   - high bar: |z| >= 2.2 (a real outlier for you, not a wobble)
//   - quiet-hours aware (reuses the nudge runner's window)
//   - one push per metric per day (dedup ledger), one push per run (the
//     strongest signal — a rough night trips HRV+RHR+sleep together, and three
//     pushes for one cause is noise)
require('dotenv').config();
const { baselineAnomaly } = require('./stats');
const metricsStore = require('../store/metrics');
const nudgesStore = require('../store/nudges');
const devicesStore = require('../store/devices');
const { withinQuietHours } = require('./nudges');
const { sendPush } = require('../notify/expo');
const { localDayBoundsUtc } = require('../util/date');

// HRV/RHR are source-locked to the overnight Eight Sleep series (+ seeded
// baseline), exactly as recovery/analyze do — daytime Apple Watch readings run
// higher and would make a normal overnight value look like a dip.
const NIGHT = ['eight_sleep', 'eight_sleep_baseline'];
const ES = ['eight_sleep'];

// The metrics worth interrupting a day for, each with the BAD direction (the one
// that signals strain/illness/under-recovery) and a one-line "what to do".
const WATCHED = [
  {
    metric: 'hrv', sources: NIGHT, bad: 'down',
    title: 'Your HRV dropped',
    label: 'HRV', unit: 'ms',
    guidance: 'Your nervous system is strained — keep today easy and protect tonight’s sleep.',
  },
  {
    metric: 'resting_hr', sources: NIGHT, bad: 'up',
    title: 'Resting HR is up',
    label: 'Resting HR', unit: 'bpm',
    guidance: 'Elevated resting HR can mean incomplete recovery or oncoming illness — ease off and hydrate.',
  },
  {
    metric: 'sleep_score', sources: ES, bad: 'down',
    title: 'Rough night',
    label: 'Sleep score', unit: '',
    guidance: 'Expect lower focus this afternoon — lighten the load and aim for an earlier bedtime tonight.',
  },
  {
    metric: 'respiratory_rate', sources: NIGHT, bad: 'up',
    title: 'Breathing rate elevated',
    label: 'Respiratory rate', unit: '/min', decimals: 1,
    guidance: 'A raised overnight breathing rate is an early illness/strain signal — watch it and rest.',
  },
];

const THRESHOLD = 2.2; // |z| past this is a genuine outlier worth a mid-day ping
const BASELINE_DAYS = 30;
const MIN_N = 8;

/** Pure: does a z-score qualify as a push-worthy anomaly given the metric's BAD
 *  direction? Only the strain/illness direction earns an interruption — a great
 *  HRV day is nice but not urgent. */
function qualifies(badDirection, z, threshold = THRESHOLD) {
  if (z == null || !Number.isFinite(z)) return false;
  return badDirection === 'down' ? z <= -threshold : z >= threshold;
}

function dayKey(d = new Date()) {
  const tz = process.env.TZ || 'America/New_York';
  return new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
}

function fmtValue(v, cfg) {
  if (cfg.decimals != null) return v.toFixed(cfg.decimals);
  return String(Math.round(v));
}

// Spending/financial annotations are never a driver of a HEALTH anomaly — a
// "Vacation bills" note explains your wallet, not your HRV. Same filter the
// analyze anomaly path uses, so the two stay consistent.
const SPEND_RE = /spend|wealth|financ|budget|\$\d|money|bill/i;
function isSpendingAnnotation(a) {
  const cat = String(a.category || '').toLowerCase();
  if (cat.includes('spend') || cat.includes('wealth') || cat.includes('financ')) return true;
  return SPEND_RE.test(`${a.label || ''} ${a.note || ''}`);
}

/** Active life-context labels overlapping yesterday→now, e.g. "travel", "late night". */
async function contextNote() {
  try {
    const annotationsStore = require('../store/annotations');
    const { start } = localDayBoundsUtc(process.env.TZ || 'America/New_York', new Date(Date.now() - 24 * 60 * 60 * 1000));
    const active = await annotationsStore.overlapping(start, new Date());
    const life = active.filter((a) => !isSpendingAnnotation(a));
    if (!life.length) return '';
    const labels = life.slice(0, 2).map((a) => a.label || a.category).filter(Boolean);
    return labels.length ? ` You logged: ${labels.join(', ')}.` : '';
  } catch {
    return '';
  }
}

/**
 * Scan the watched metrics against the user's own baseline and, if the strongest
 * deviation clears the bar, push ONE contextual message. Non-blocking by design:
 * callers fire-and-forget after an ingest so the request never waits on it.
 *
 * @param {{ metrics?: Array<{metric:string}>, asOf?: Date, send?: boolean, force?: boolean }} [opts]
 *   metrics — only consider these metric names (the ones just written); omit to scan all.
 */
async function runWatch(opts = {}) {
  const asOf = opts.asOf ? new Date(opts.asOf) : new Date();
  const send = opts.send !== false;
  if (!opts.force && withinQuietHours(asOf)) return { skipped: 'quiet_hours' };

  const onlyMetrics = opts.metrics ? new Set(opts.metrics.map((m) => m.metric)) : null;
  const from = new Date(Date.now() - 60 * 864e5);
  const recent = await nudgesStore.recentlySentKeys(1); // one ping per metric per day

  // Find the single strongest qualifying anomaly across all watched metrics.
  let best = null;
  for (const cfg of WATCHED) {
    if (onlyMetrics && !onlyMetrics.has(cfg.metric)) continue;
    const key = `watch:${cfg.metric}:${dayKey(asOf)}`;
    if (recent.has(key)) continue;

    let series;
    try {
      series = await metricsStore.dailyAggregatePreferSource({
        domain: 'health', metric: cfg.metric, from, agg: 'avg', sources: cfg.sources,
      });
    } catch { continue; }

    // Staleness guard: Eight Sleep reads are dated by the WAKE morning, so a fresh
    // overnight value carries today's date. If the latest reading predates today,
    // there was no session last night — don't push "your HRV dropped" on a
    // 1–2-night-old reading (the whole point is fresh-overnight alerts).
    const latestDay = series.length ? series[series.length - 1].day : null;
    if (latestDay) {
      const readingDayKey = new Date(latestDay).toISOString().slice(0, 10);
      const todayLocal = new Date(asOf).toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/New_York' });
      if (readingDayKey < todayLocal) continue;
    }

    const a = baselineAnomaly(series, { baselineDays: BASELINE_DAYS, minN: MIN_N });
    if (!a) continue;

    if (!qualifies(cfg.bad, a.z)) continue;
    if (!best || Math.abs(a.z) > Math.abs(best.a.z)) best = { cfg, a, key };
  }

  if (!best) return { generated: 0, sent: 0 };

  const { cfg, a, key } = best;
  const dir = a.z < 0 ? 'below' : 'above';
  const pctDiff = a.baselineMean !== 0
    ? Math.round(Math.abs((a.latest - a.baselineMean) / a.baselineMean) * 100)
    : null;
  const valStr = `${fmtValue(a.latest, cfg)}${cfg.unit}`;
  const baseStr = `${fmtValue(a.baselineMean, cfg)}${cfg.unit}`;
  const pctClause = pctDiff != null ? `${pctDiff}% ${dir} ` : `${dir} `;
  const ctx = await contextNote();
  const body = `${cfg.label} is ${valStr} — ${pctClause}your 30-day norm (${baseStr}).${ctx} ${cfg.guidance}`;

  const nudge = {
    key,
    title: cfg.title,
    body,
    priority: Math.min(0.95, 0.6 + (Math.abs(a.z) - THRESHOLD) * 0.1),
    basis: { type: 'watch', metric: cfg.metric, z: Math.round(a.z * 100) / 100, latest: a.latest, baselineMean: a.baselineMean },
  };

  const tokens = send ? await devicesStore.listActiveTokens() : [];
  const status = send && tokens.length === 0 ? 'skipped' : 'pending';
  const id = await nudgesStore.recordNudge({ ...nudge, dedupKey: nudge.key, status });
  // null means another concurrent caller already claimed this exact nudge
  // (recordNudge's atomic dedup guard) — don't push a second time.
  if (id == null) return { generated: 1, sent: 0, skipped: 'concurrent_duplicate', nudge };

  if (send && tokens.length > 0) {
    try {
      const r = await sendPush(tokens, { title: nudge.title, body: nudge.body, data: { key: nudge.key } });
      for (const dead of r.invalidTokens) await devicesStore.deactivate(dead);
      await nudgesStore.markStatus(id, 'sent');
      return { generated: 1, sent: 1, devices: tokens.length, nudge };
    } catch (err) {
      await nudgesStore.markStatus(id, 'failed');
      return { generated: 1, sent: 0, error: err.message, nudge };
    }
  }

  return { generated: 1, sent: 0, devices: tokens.length, nudge };
}

module.exports = { runWatch, qualifies, WATCHED, THRESHOLD };

// CLI: `node src/intelligence/watch.js [--force] [--dry-run]`
if (require.main === module) {
  const { pool } = require('../db');
  const force = process.argv.includes('--force');
  const dryRun = process.argv.includes('--dry-run');
  runWatch({ force, send: !dryRun })
    .then((s) => {
      if (s.skipped) return console.log(`Skipped (${s.skipped}).`);
      if (!s.generated) return console.log('No anomaly past threshold — nothing to send.');
      console.log(`[watch] ${s.sent ? 'sent' : 'generated'}: ${s.nudge.title} — ${s.nudge.body}`);
    })
    .catch((err) => { console.error('Watch run failed:', err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
