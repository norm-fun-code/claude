// Nightly self-model consolidation — the keystone of the intelligence layer.
//
// Builds a comprehensive, structured portrait of the user from all data sources
// and saves it to the self_model table. This model is then injected into every
// voice surface (morning brief, chat, weekly review) so each one starts with
// full context rather than cold-starting from scratch.
//
// Data-driven (no LLM call) for reliability and speed. Accuracy over poetry;
// the voice surfaces' LLMs add the narrative polish. Runs nightly after the
// evening analyze pass, and on-demand via POST /api/consolidate.
require('dotenv').config();
const metricsStore = require('../store/metrics');
const findingsStore = require('../store/findings');
const experimentsStore = require('../store/experiments');
const intentionsStore = require('../store/intentions');
const annotationsStore = require('../store/annotations');
const selfModelStore = require('../store/selfModel');
const { query: dbQuery } = require('../db');

const DAY = 24 * 60 * 60 * 1000;

function avg(rows) {
  const v = rows.map((r) => Number(r.value)).filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// Median for the BASELINE side of "current vs baseline" comparisons: one
// anomalous week (a hiking vacation, a travel bender) inside the window barely
// moves a median, where it drags a mean and makes the return to normal life
// read as a dramatic decline against an abnormal reference.
function medianOf(rows) {
  const v = rows.map((r) => Number(r.value)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function sum(rows) {
  const v = rows.map((r) => Number(r.value)).filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}

function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}

function pct(n, d) {
  if (n == null || d == null || d === 0) return null;
  return Math.round(((n - d) / Math.abs(d)) * 100);
}

function dirArrow(current, prior, goodWhen = 'up') {
  if (current == null || prior == null) return '';
  const delta = current - prior;
  const improving = goodWhen === 'down' ? delta < 0 : delta > 0;
  if (Math.abs(delta) < 0.05 * Math.abs(prior || 1)) return ' →';
  return improving ? ' ↑' : ' ↓';
}

function fmtPct(n) {
  if (n == null) return '';
  return ` (${n >= 0 ? '+' : ''}${n}% vs your 28d norm)`;
}

// ---- Data gatherers ----

async function gatherWellbeing(d7, d35) {
  const metrics = ['mood', 'energy', 'focus'];
  const out = {};
  for (const m of metrics) {
    const [cur, prior] = await Promise.all([
      metricsStore.dailyAggregate({ domain: 'wellbeing', metric: m, from: d7, agg: 'avg', excludeSource: 'seed' }),
      metricsStore.dailyAggregate({ domain: 'wellbeing', metric: m, from: d35, to: d7, agg: 'avg', excludeSource: 'seed' }),
    ]);
    out[m] = { cur: round1(avg(cur)), prior: round1(medianOf(prior)) };
  }
  return out;
}

async function gatherHealth(d7, d35) {
  // HRV/RHR: source-lock to Eight Sleep manual entries + the seeded baseline so
  // the self-model uses the same night-vs-night comparison as analyze() and
  // liveRecovery(). Without this, Apple Watch daytime HRV bleeds in on days
  // without an Eight Sleep entry, producing a different (higher) number than the
  // Insights / Recovery card, causing user confusion.
  const NIGHT_SOURCES = ['eight_sleep', 'eight_sleep_baseline'];
  const SOURCE_LOCK = { hrv: NIGHT_SOURCES, resting_hr: NIGHT_SOURCES };
  // Sleep totals and scores: source-priority is enough (no hard lock needed).
  const PREFER_SOURCE = new Set(['hrv', 'resting_hr', 'sleep_hours', 'sleep_score', 'deep_sleep_hours', 'rem_sleep_hours']);
  const metrics = [
    ['hrv', 'avg', 'up'],
    ['resting_hr', 'avg', 'down'],
    ['sleep_hours', 'avg', 'up'],
    ['sleep_score', 'avg', 'up'],
    ['steps', 'avg', 'up'],
    ['active_energy', 'avg', 'up'],
  ];
  const out = {};
  for (const [m, agg, gw] of metrics) {
    const aggFn = PREFER_SOURCE.has(m)
      ? (opts) => metricsStore.dailyAggregatePreferSource({ ...opts, agg, sources: SOURCE_LOCK[m] ?? null })
      : (opts) => metricsStore.dailyAggregate({ ...opts, agg, excludeSource: 'seed' });
    const [cur, prior] = await Promise.all([
      aggFn({ domain: 'health', metric: m, from: d7 }),
      aggFn({ domain: 'health', metric: m, from: d35, to: d7 }),
    ]);
    out[m] = { cur: round1(avg(cur)), prior: round1(medianOf(prior)), goodWhen: gw };
  }
  return out;
}

// How many consecutive weeks the user hit the habit threshold.
// Weeks are Mon–Sun; the current (partial) week counts if already at target.
function computeStreak(rows, threshold) {
  const weekMap = new Map();
  for (const row of rows) {
    const d = new Date(row.day);
    const dow = d.getDay(); // 0=Sun
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((dow + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    if (!weekMap.has(key)) weekMap.set(key, []);
    weekMap.get(key).push(Number(row.value));
  }
  const weeks = [...weekMap.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  let streak = 0;
  for (const [, vals] of weeks) {
    const weekAvg = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (weekAvg >= threshold) streak++;
    else break;
  }
  return streak;
}

async function gatherHabits(d7, d56) {
  const BINARY = ['morning_tm', 'afternoon_tm', 'gratitude', 'cold_shower', 'exercise'];
  const LABELS = {
    morning_tm: 'Morning TM', afternoon_tm: 'Afternoon TM', gratitude: 'Gratitude',
    cold_shower: 'Cold shower', exercise: 'Exercise', eat_healthy: 'Eating well',
  };
  const out = {};
  for (const m of BINARY) {
    const rows = await metricsStore.dailyAggregate({ domain: 'habits', metric: m, from: d56, agg: 'avg', excludeSource: 'seed' });
    const recent = rows.filter((r) => new Date(r.day) >= d7);
    const rate = avg(recent);
    const streak = computeStreak(rows, 0.71); // ≥5/7 days per week
    out[m] = { rate: rate != null ? Math.round(rate * 100) : null, label: LABELS[m], streak };
  }
  const eatRows = await metricsStore.dailyAggregate({ domain: 'habits', metric: 'eat_healthy', from: d56, agg: 'avg', excludeSource: 'seed' });
  const recentEat = eatRows.filter((r) => new Date(r.day) >= d7);
  const eatStreak = computeStreak(eatRows, 3.5); // ≥3.5/5 per week
  out.eat_healthy = { rate: round1(avg(recentEat)), label: LABELS.eat_healthy, scale: 5, streak: eatStreak };
  return out;
}

async function gatherWealth(d30) {
  const nw = await metricsStore.latest({ domain: 'wealth', metric: 'net_worth' });
  const nwPrev = await metricsStore.dailyAggregate({
    domain: 'wealth', metric: 'net_worth',
    from: new Date(Date.now() - 60 * DAY), to: new Date(Date.now() - 30 * DAY),
    agg: 'avg', excludeSource: 'seed',
  });
  // MTD = calendar month, not rolling 30d. Use UTC month boundary — dailyAggregate
  // groups by date_trunc('day', ts) which is UTC-based, so we match the same anchor.
  // Use spending_DISCRETIONARY so rent/mortgage (fixed housing) is excluded — an
  // MTD number that includes a $X,XXX rent line isn't an actionable "how am I
  // pacing" figure, it's dominated by a bill that never changes.
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const spending = await metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending_discretionary', from: monthStart, agg: 'sum', excludeSource: 'seed' });
  return {
    netWorth: nw ? Number(nw.value) : null,
    netWorthPrev: avg(nwPrev),
    spendingMtd: sum(spending),
  };
}

async function gatherGoals() {
  try {
    const { rows } = await dbQuery(
      `SELECT id, domain, title, metric, target_value, unit, target_date, status, baseline_value
         FROM goals WHERE status = 'active' ORDER BY target_date NULLS LAST LIMIT 8`
    );
    return rows;
  } catch { return []; }
}

async function gatherExperiments() {
  try {
    const all = await experimentsStore.listExperiments();
    const completed = all.filter((e) => e.status === 'completed' && e.verdict).slice(0, 5);
    const running = all.filter((e) => e.status === 'running').slice(0, 3);
    return { completed, running };
  } catch { return { completed: [], running: [] }; }
}

async function gatherFindings() {
  try {
    const open = await findingsStore.listFindings({ status: 'open' });
    const correlations = open.filter((f) => f.type === 'correlation' && f.evidence?.confirmed === true).slice(0, 5);
    const leverage = open.filter((f) => f.type === 'leverage').slice(0, 3);
    return { correlations, leverage };
  } catch { return { correlations: [], leverage: [] }; }
}

async function gatherAnnotations() {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return await annotationsStore.overlapping(today, new Date());
  } catch { return []; }
}

// ---- Model builder ----

function buildModelText(data) {
  const { wellbeing, health, habits, wealth, goals, experiments, findings, annotations, intention, generatedAt } = data;
  const lines = [];

  const dateStr = (generatedAt || new Date()).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  lines.push(`SELF-MODEL — last updated ${dateStr}`);
  lines.push('This is NormOS\'s consolidated understanding of the user, built from all data sources.');
  lines.push('');

  // --- Health ---
  const h = health;
  const healthParts = [];
  if (h.hrv?.cur != null) {
    const d = dirArrow(h.hrv.cur, h.hrv.prior, 'up');
    healthParts.push(`HRV ${h.hrv.cur}ms avg${d}${h.hrv.prior != null ? fmtPct(pct(h.hrv.cur, h.hrv.prior)) : ''}`);
  }
  if (h.resting_hr?.cur != null) healthParts.push(`RHR ${h.resting_hr.cur}bpm${dirArrow(h.resting_hr.cur, h.resting_hr.prior, 'down')}`);
  if (h.sleep_hours?.cur != null) {
    const d = dirArrow(h.sleep_hours.cur, h.sleep_hours.prior, 'up');
    healthParts.push(`Sleep ${h.sleep_hours.cur}h avg${d}`);
  }
  if (h.sleep_score?.cur != null) healthParts.push(`Sleep score ${h.sleep_score.cur}/100`);
  if (h.steps?.cur != null) healthParts.push(`Steps ${Math.round(h.steps.cur).toLocaleString()} avg/day`);
  if (healthParts.length) lines.push(`HEALTH (last 7 days): ${healthParts.join(' · ')}`);

  // --- Habits ---
  const habitLines = [];
  for (const [key, v] of Object.entries(habits)) {
    if (v.rate == null) continue;
    if (v.scale === 5) {
      habitLines.push(`${v.label} ${v.rate}/5`);
    } else {
      const days = Math.round((v.rate / 100) * 7);
      const mark = v.rate >= 80 ? '✓' : v.rate < 50 ? '↓' : '';
      habitLines.push(`${v.label} ${days}/7${mark ? ' ' + mark : ''}`);
    }
  }
  if (habitLines.length) lines.push(`HABITS THIS WEEK: ${habitLines.join(' · ')}`);

  // --- Wellbeing ---
  const wb = wellbeing;
  const wbParts = [];
  const wbLabel = { mood: 'Mood', energy: 'Energy', focus: 'Focus' };
  const wbLevel = (v) => v == null ? null : v >= 4 ? 'strong' : v >= 3 ? 'moderate' : 'low';
  // Mood/energy/focus are logged on a coarse 1–5 scale, so a small week-over-week
  // dip while a metric is still in the 'strong' band (≥4) is noise, not a
  // downtrend. Suppress the down-arrow in that case so the brief doesn't escalate
  // a 4.6→4.3 wiggle into "mood is sliding". A real drop (≥0.5 pt) or a fall out
  // of the strong band still shows ↓.
  const wbArrow = (cur, prior) => {
    if (prior == null) return '';
    const a = dirArrow(cur, prior, 'up');
    if (a === ' ↓' && cur >= 4 && (prior - cur) < 0.5) return ' →';
    return a;
  };
  for (const [k, v] of Object.entries(wb)) {
    if (v.cur == null) continue;
    wbParts.push(`${wbLabel[k]} ${v.cur}/5 (${wbLevel(v.cur)}${wbArrow(v.cur, v.prior)})`);
  }
  if (wbParts.length) lines.push(`WELLBEING (last 7 days): ${wbParts.join(' · ')}`);

  // --- Wealth ---
  if (wealth.netWorth != null) {
    const nwStr = `$${Math.round(wealth.netWorth).toLocaleString()}`;
    const changeStr = wealth.netWorthPrev != null
      ? ` (${pct(wealth.netWorth, wealth.netWorthPrev) >= 0 ? '+' : ''}${pct(wealth.netWorth, wealth.netWorthPrev)}% vs 30d prior)`
      : '';
    const spendStr = wealth.spendingMtd != null
      ? `, MTD discretionary spending $${Math.round(wealth.spendingMtd).toLocaleString()} (excludes rent/mortgage)`
      : '';
    lines.push(`WEALTH: Net worth ${nwStr}${changeStr}${spendStr}`);
  }

  // --- Goals ---
  if (goals.length) {
    const goalLines = goals.map((g) => {
      const tgt = g.target_value != null ? ` → target ${g.target_value}${g.unit ? ' ' + g.unit : ''}` : '';
      const by = g.target_date ? ` by ${new Date(g.target_date).toISOString().slice(0, 10)}` : '';
      return `${g.title}${tgt}${by}`;
    });
    lines.push(`ACTIVE GOALS: ${goalLines.join(' · ')}`);
  }

  // --- Experiments: self-tested causal knowledge, the strongest ground there is ---
  const expPct = (e) => (e.result?.pctChange != null ? ` (${e.result.pctChange > 0 ? '+' : ''}${Math.round(e.result.pctChange * 100)}% on ${e.metric})` : '');
  const proven = experiments.completed.filter((e) => e.verdict === 'confirmed');
  const ruledOut = experiments.completed.filter((e) => e.verdict === 'refuted');
  const inconclusive = experiments.completed.filter((e) => e.verdict && e.verdict !== 'confirmed' && e.verdict !== 'refuted');
  if (proven.length) {
    lines.push(
      `PROVEN ON YOU (self-tested experiments CONFIRMED on their own data — cite these as proof, not association; this is your strongest ground for advice):\n` +
        proven.map((e) => `  ✓ "${e.hypothesis}"${expPct(e)}`).join('\n')
    );
  }
  if (ruledOut.length) {
    lines.push(
      `RULED OUT (self-tested, showed no effect on THEM — do not re-suggest as if untried):\n` +
        ruledOut.map((e) => `  ✗ "${e.hypothesis}"${expPct(e)}`).join('\n')
    );
  }
  const expLines = [];
  for (const e of inconclusive) expLines.push(`~ Inconclusive: "${e.hypothesis}"${expPct(e)}`);
  for (const e of experiments.running) {
    const daysLeft = e.end_date ? Math.max(0, Math.ceil((new Date(e.end_date) - Date.now()) / DAY)) : null;
    expLines.push(`⟳ Running: "${e.hypothesis}"${daysLeft != null ? ` (${daysLeft} days left)` : ''}`);
  }
  if (expLines.length) lines.push(`EXPERIMENTS:\n${expLines.map((l) => `  ${l}`).join('\n')}`);

  // --- Confirmed relationships ---
  if (findings.correlations.length) {
    lines.push(`CONFIRMED RELATIONSHIPS: ${findings.correlations.map((f) => f.title).join(' · ')}`);
  }

  // --- Highest leverage ---
  if (findings.leverage.length) {
    lines.push(`HIGHEST LEVERAGE RIGHT NOW: ${findings.leverage.map((f, i) => `${i + 1}. ${f.title}`).join(' · ')}`);
  }

  // --- Current intention ---
  if (intention) {
    const wk = intention.weekStart ? new Date(intention.weekStart).toISOString().slice(0, 10) : 'this week';
    const goalsStr = Array.isArray(intention.goals) && intention.goals.length
      ? intention.goals.map((g) => g.text || g).join(', ')
      : '';
    const ctx = intention.context ? ` Context: ${intention.context}` : '';
    lines.push(`STATED FOCUS (week of ${wk}): ${goalsStr}${ctx}`);
  }

  // --- Active life context ---
  if (annotations.length) {
    lines.push(`ACTIVE CONTEXT: ${annotations.map((a) => `${a.category}: ${a.label}`).join('; ')}`);
  }

  return lines.join('\n');
}

// ---- Main consolidation job ----

async function consolidate({ kind = 'nightly' } = {}) {
  const now = new Date();
  const d7 = new Date(now - 7 * DAY);
  // Baseline window: the 28 days BEFORE the current week (d35→d7), compared as
  // a median — so one vacation week can't become "the reference" and make the
  // return to normal life read as a decline.
  const d35 = new Date(now - 35 * DAY);
  const d30 = new Date(now - 30 * DAY);
  const d56 = new Date(now - 56 * DAY);

  const [wellbeing, health, habits, wealth, goals, experiments, findings, annotations, intentionArr] =
    await Promise.all([
      gatherWellbeing(d7, d35),
      gatherHealth(d7, d35),
      gatherHabits(d7, d56),
      gatherWealth(d30),
      gatherGoals(),
      gatherExperiments(),
      gatherFindings(),
      gatherAnnotations(),
      intentionsStore.recentIntentions({ days: 14 }).catch(() => []),
    ]);

  const intention = intentionArr[0] ?? null;

  const snapshot = {
    wellbeing,
    health,
    habits,
    wealth,
    goals: goals.length,
    goalsList: goals.slice(0, 6).map((g) => ({ id: g.id, title: g.title, targetDate: g.target_date ?? null })),
    experiments,
    findings: findings.correlations.length,
    topFindings: findings.correlations.slice(0, 3).map((f) => ({ title: f.title })),
  };
  const content = buildModelText({ wellbeing, health, habits, wealth, goals, experiments, findings, annotations, intention, generatedAt: now });

  await selfModelStore.saveModel({ content, snapshot, kind });
  return content;
}

module.exports = { consolidate, buildModelText };

if (require.main === module) {
  const { pool } = require('../db');
  consolidate({ kind: 'manual' })
    .then((text) => { console.log('\n--- SELF-MODEL ---\n'); console.log(text); })
    .catch((err) => { console.error('Consolidate failed:', err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
