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
const { localDayBoundsUtc } = require('../util/date');
// nudgesStore/devicesStore/sendPush/withinQuietHours were used here directly
// before the Attention Policy migration — delivery, dedup, and quiet-hours
// are now decided by notify/dispatch.js's dispatchEvent(), required lazily
// below (avoids a require cycle: dispatch -> beliefs -> attention store, and
// watch.js is required very early by the scheduler).

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

/** Active life-context labels overlapping yesterday→now, e.g. "travel", "late night".
 *  'general' purpose (see context-semantics.js) — excludes financial notes
 *  (a "Vacation bills" note explains your wallet, not your HRV) AND
 *  retractions/retired annotations, so a "forget that context" correction
 *  never shows up in the same-day nudge either. */
async function contextNote() {
  try {
    const annotationsStore = require('../store/annotations');
    const { filterEligible } = require('./context-semantics');
    const { start } = localDayBoundsUtc(process.env.TZ || 'America/New_York', new Date(Date.now() - 24 * 60 * 60 * 1000));
    const active = await annotationsStore.overlapping(start, new Date());
    const life = filterEligible(active, { purpose: 'general' });
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
  // Quiet hours are no longer checked here — the attention policy (dispatch)
  // decides that now, and needs to actually SEE the event to evaluate a
  // critical-override bypass. Detection still runs during quiet hours; a
  // non-critical anomaly found then is simply deferred by the policy
  // (add_to_brief), not silently skipped before it's even built.

  const onlyMetrics = opts.metrics ? new Set(opts.metrics.map((m) => m.metric)) : null;
  const from = new Date(Date.now() - 60 * 864e5);

  // Find the single strongest qualifying anomaly across all watched metrics
  // (unchanged: "one push per run" is a deliberate noise-control choice — a
  // rough night trips HRV+RHR+sleep together, and three pushes for one cause
  // is noise — independent of the policy's own cross-surface dedup, which is
  // per-SUBJECT and wouldn't otherwise stop HRV and RHR both firing).
  // NOTE (migration divergence from pre-policy behavior): per-metric
  // "already sent today" used to be filtered OUT before picking the
  // strongest, so a cooled-down top metric would yield to a runner-up. That
  // cooldown now lives in the policy, which only sees the ONE candidate this
  // function selects — so a cooled-down top metric now suppresses this run
  // entirely rather than yielding. Low-risk given this fires on every health
  // ingest: a genuine runner-up anomaly gets evaluated fresh on the next one.
  let best = null;
  for (const cfg of WATCHED) {
    if (onlyMetrics && !onlyMetrics.has(cfg.metric)) continue;

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
    if (!best || Math.abs(a.z) > Math.abs(best.a.z)) best = { cfg, a };
  }

  if (!best) return { generated: 0, sent: 0 };

  const { cfg, a } = best;
  const dir = a.z < 0 ? 'below' : 'above';
  const pctDiff = a.baselineMean !== 0
    ? Math.round(Math.abs((a.latest - a.baselineMean) / a.baselineMean) * 100)
    : null;
  const valStr = `${fmtValue(a.latest, cfg)}${cfg.unit}`;
  const baseStr = `${fmtValue(a.baselineMean, cfg)}${cfg.unit}`;
  const pctClause = pctDiff != null ? `${pctDiff}% ${dir} ` : `${dir} `;
  const ctx = await contextNote();
  const body = `${cfg.label} is ${valStr} — ${pctClause}your 30-day norm (${baseStr}).${ctx} ${cfg.guidance}`;

  const event = require('./events').fromHealthAnomaly({ cfg, a, asOf, title: cfg.title, body });
  const { dispatchEvent } = require('../notify/dispatch');
  const result = await dispatchEvent(event, { asOf, send, force: opts.force });
  return {
    generated: 1, sent: result.delivered ? 1 : 0,
    disposition: result.decision.disposition, reason: result.decision.reason,
    nudge: { key: require('./attention').eventKey(event), title: event.title, body: event.body },
  };
}

// ---- Wellbeing watcher — same-day reaction to a low check-in ----------------
//
// The temporal audit's scenario (d): the user logs a rough 3pm check-in and
// the system does nothing until tomorrow's brief. Unlike the metric watcher
// above, this needs no baseline statistics — on a 1-5 scale, a 2 IS the
// signal. Same dedup ledger and quiet-hours discipline as runWatch; no
// annotation is written because the check-in metrics themselves are already
// the source of truth every brief reads (writing a second copy would be the
// exact duplicated-fact pattern the reconciliation work removed).
const LOW_CUTOFF = 2;

async function watchWellbeing({ mood, energy, focus, asOf = new Date(), send = true, force = false } = {}) {
  // Quiet hours are decided by the policy now (see runWatch's comment above)
  // — detection always runs so a genuinely critical case could in principle
  // bypass quiet hours; a low check-in never matches the (health-only)
  // CRITICAL_ALLOWLIST today, so in practice this still defers during quiet
  // hours exactly as before, just via the policy instead of a local check.
  const low = [];
  if (Number(mood) >= 1 && Number(mood) <= LOW_CUTOFF) low.push('mood');
  if (Number(energy) >= 1 && Number(energy) <= LOW_CUTOFF) low.push('energy');
  if (Number(focus) >= 1 && Number(focus) <= LOW_CUTOFF) low.push('focus');
  if (!low.length) return { generated: 0, sent: 0 };

  const what = low.length === 1 ? low[0] : `${low.slice(0, -1).join(', ')} and ${low[low.length - 1]}`;
  const title = 'Rough one today';
  const body =
    `Your check-in says ${what} ${low.length > 1 ? 'are' : 'is'} running low. ` +
    `Downshift the rest of the day: one small win counts, skip anything heavy, and protect tonight's wind-down — tomorrow starts from tonight.`;

  const event = require('./events').fromLowCheckin({ low, mood, energy, focus, asOf, title, body });
  const { dispatchEvent } = require('../notify/dispatch');
  const result = await dispatchEvent(event, { asOf, send, force });
  return {
    generated: 1, sent: result.delivered ? 1 : 0,
    disposition: result.decision.disposition, reason: result.decision.reason,
    nudge: { key: require('./attention').eventKey(event), title, body },
  };
}

module.exports = { runWatch, watchWellbeing, qualifies, WATCHED, THRESHOLD, LOW_CUTOFF };

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
