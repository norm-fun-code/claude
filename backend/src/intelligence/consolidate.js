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
const { filterEligible } = require('./context-semantics');
const selfModelStore = require('../store/selfModel');
const cat = require('./catalog');
const { query: dbQuery } = require('../db');
const { localDayBoundsUtc, localMonthKeyStartUtc } = require('../util/date');

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
  // Each metric's fetch is independent — parallelize across metrics too, not
  // just within each metric's own cur/prior pair.
  const results = await Promise.all(metrics.map(async (m) => {
    const [cur, prior] = await Promise.all([
      metricsStore.dailyAggregate({ domain: 'wellbeing', metric: m, from: d7, agg: 'avg', excludeSource: 'seed' }),
      metricsStore.dailyAggregate({ domain: 'wellbeing', metric: m, from: d35, to: d7, agg: 'avg', excludeSource: 'seed' }),
    ]);
    return [m, { cur: round1(avg(cur)), prior: round1(medianOf(prior)) }];
  }));
  return Object.fromEntries(results);
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
  // Same staleness bar as analyze.js's trend suppression: a night-sourced metric
  // (Eight Sleep) that's stopped posting doesn't stop having rows in the "last 7
  // days" window until those rows age out entirely — until then, this would keep
  // averaging whatever nights were last available and reporting it as the
  // current 7-day figure, letting the self-model (and everything it feeds — the
  // brief, chat) narrate a stale reading as if it were live.
  const { NIGHT_METRICS, staleDays, TREND_STALE_DAYS } = require('./analyze');
  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/New_York' });

  // Each metric's fetch is independent — parallelize across metrics too, not
  // just within each metric's own cur/prior pair.
  const results = await Promise.all(metrics.map(async ([m, agg, gw]) => {
    const aggFn = PREFER_SOURCE.has(m)
      ? (opts) => metricsStore.dailyAggregatePreferSource({ ...opts, agg, sources: SOURCE_LOCK[m] ?? null })
      : (opts) => metricsStore.dailyAggregate({ ...opts, agg, excludeSource: 'seed' });
    const [cur, prior] = await Promise.all([
      aggFn({ domain: 'health', metric: m, from: d7 }),
      aggFn({ domain: 'health', metric: m, from: d35, to: d7 }),
    ]);
    let curAvg = round1(avg(cur));
    if (NIGHT_METRICS.has(`health:${m}`)) {
      const age = staleDays(cur, todayKey);
      if (age != null && age > TREND_STALE_DAYS) curAvg = null; // no fresh reading — suppress rather than report a frozen average
    }
    return [m, { cur: curAvg, prior: round1(medianOf(prior)), goodWhen: gw }];
  }));
  return Object.fromEntries(results);
}

async function gatherHabits(d7, d56) {
  const BINARY = ['morning_tm', 'afternoon_tm', 'gratitude', 'cold_shower', 'exercise'];
  const LABELS = {
    morning_tm: 'Morning TM', afternoon_tm: 'Afternoon TM', gratitude: 'Gratitude',
    cold_shower: 'Cold shower', exercise: 'Exercise', eat_healthy: 'Eating well',
  };
  // Each binary habit's fetch plus the eat_healthy fetch are all independent —
  // parallelize instead of one round trip at a time.
  const [binaryResults, eatRows] = await Promise.all([
    Promise.all(BINARY.map(async (m) => {
      const rows = await metricsStore.dailyAggregate({ domain: 'habits', metric: m, from: d56, agg: 'avg', excludeSource: 'seed' });
      const recent = rows.filter((r) => new Date(r.day) >= d7);
      const rate = avg(recent);
      return [m, { rate: rate != null ? Math.round(rate * 100) : null, label: LABELS[m] }];
    })),
    metricsStore.dailyAggregate({ domain: 'habits', metric: 'eat_healthy', from: d56, agg: 'avg', excludeSource: 'seed' }),
  ]);
  const out = Object.fromEntries(binaryResults);
  const recentEat = eatRows.filter((r) => new Date(r.day) >= d7);
  out.eat_healthy = { rate: round1(avg(recentEat)), label: LABELS.eat_healthy, scale: 5 };
  return out;
}

async function gatherWealth(d30) {
  // MTD = the user's LOCAL calendar month. Wealth flow metrics are keyed to the
  // local calendar DAY but stored at UTC-midnight of that day-string (see
  // monarch.js dayTs: local July 1 -> 2026-07-01T00:00:00Z), so the correct
  // month boundary is UTC-midnight of the local month-first-day string
  // (localMonthKeyStartUtc). An earlier fix used localMonthStartUtc (TRUE local
  // midnight = 04:00Z in EDT), which silently DROPPED the 1st-of-month's
  // spending from every MTD sum — its 04:00Z lower bound sorts after the 1st's
  // 00:00Z metric. Verified empirically against the stored ts.
  // Use spending_DISCRETIONARY so rent/mortgage (fixed housing) is excluded — an
  // MTD number that includes a $X,XXX rent line isn't an actionable "how am I
  // pacing" figure, it's dominated by a bill that never changes.
  const now = new Date();
  const monthStart = localMonthKeyStartUtc(process.env.TZ || 'America/New_York', now);
  // All three fetches below are independent — parallelize.
  const [nw, nwPrev, spending] = await Promise.all([
    metricsStore.latest({ domain: 'wealth', metric: 'net_worth' }),
    metricsStore.dailyAggregate({
      domain: 'wealth', metric: 'net_worth',
      from: new Date(Date.now() - 60 * DAY), to: new Date(Date.now() - 30 * DAY),
      agg: 'avg', excludeSource: 'seed',
    }),
    metricsStore.dailyAggregate({ domain: 'wealth', metric: 'spending_discretionary', from: monthStart, agg: 'sum', excludeSource: 'seed' }),
  ]);
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
    // Paused counts as active, not gone: the mobile ExperimentsCard already
    // treats running+paused as one set (it shows a paused experiment with its
    // frozen progress and a Resume link, not as absent). Previously this only
    // counted 'running', so pausing your only experiment made the Profile's
    // stats go to "0 running, 0 completed" even though a real experiment was
    // sitting right there on the same tab, on hold — a live product review
    // finding (a real experiment in a limbo state no counter acknowledged).
    const running = all.filter((e) => e.status === 'running' || e.status === 'paused').slice(0, 3);
    return { completed, running };
  } catch { return { completed: [], running: [] }; }
}

// Every finding TYPE that represents "X relates to Y in your data, confirmed":
// the generic Pearson correlation engine (gated by its own confirmed flag,
// requiring the pattern to hold across a split-half check) plus the more
// specialized detectors — habit_split, daytime_cardio, sleep_impact,
// activity_impact — which don't have a separate "confirmed" flag because
// their own significance gate (Benjamini-Hochberg FDR control) IS the
// confirmation bar; they don't fire at all otherwise. Previously this only
// counted plain 'correlation' findings, so the Profile's "0 confirmed
// correlations" stat disagreed with the 3+ correlational insights actually
// visible on the Health tab (a live product review finding) — the stat's
// definition of "correlation" was an internal implementation detail (which
// detector produced it) leaking into a user-facing number.
const CORRELATION_TYPES = new Set(['correlation', 'habit_split', 'daytime_cardio', 'sleep_impact', 'activity_impact']);

async function gatherFindings() {
  try {
    const open = await findingsStore.listFindings({ status: 'open' });
    const correlations = open
      .filter((f) => CORRELATION_TYPES.has(f.type) && (f.type !== 'correlation' || f.evidence?.confirmed === true))
      .slice(0, 5);
    const leverage = open.filter((f) => f.type === 'leverage').slice(0, 3);
    return { correlations, leverage };
  } catch { return { correlations: [], leverage: [] }; }
}

async function gatherAnnotations() {
  try {
    const { start: today } = localDayBoundsUtc(process.env.TZ || 'America/New_York');
    const active = await annotationsStore.overlapping(today, new Date());
    // 'general' purpose — the self-model's "ACTIVE CONTEXT" line feeds every
    // voice surface (chat, brief, weekly review); a retraction/retired
    // annotation must never show up there as if it were live context.
    return filterEligible(active, { purpose: 'general' });
  } catch { return []; }
}

// ---- Model builder ----

function buildModelText(data) {
  const { wellbeing, health, habits, wealth, goals, experiments, findings, annotations, intention, dayContext = [], beliefs = [], generatedAt } = data;
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
      habitLines.push(`${v.label} ${cat.wellbeingLevel(v.rate)}`);
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
  // Mood/energy/focus are logged on a coarse 1–5 scale, so a small week-over-week
  // dip while a metric is still in the 'high' band (≥4) is noise, not a
  // downtrend. Suppress the down-arrow in that case so the brief doesn't escalate
  // a 4.6→4.3 wiggle into "mood is sliding". A real drop (≥0.5 pt) or a fall out
  // of the high band still shows ↓.
  const wbArrow = (cur, prior) => {
    if (prior == null) return '';
    const a = dirArrow(cur, prior, 'up');
    if (a === ' ↓' && cur >= 4 && (prior - cur) < 0.5) return ' →';
    return a;
  };
  // Qualitative only ("Mood high ↑") — never the raw "4.2/5". The self-model
  // feeds every downstream surface (brief, chat, weekly review), so a raw
  // number here is exactly what made those surfaces read clinical/cold.
  for (const [k, v] of Object.entries(wb)) {
    if (v.cur == null) continue;
    wbParts.push(`${wbLabel[k]} ${cat.wellbeingLevel(v.cur)}${wbArrow(v.cur, v.prior)}`);
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

  // --- Durable beliefs (interaction-derived knowledge) ---
  // Everything above is recomputed from raw data each night; this section is
  // the knowledge that CAN'T be recomputed — things the user said, preference
  // patterns from their feedback — promoted into the beliefs store so it
  // survives past the 14-day context windows below. See intelligence/beliefs.js.
  {
    const beliefsSection = require('./beliefs').composeBeliefsSection(beliefs);
    if (beliefsSection) lines.push(beliefsSection);
  }

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
    // Retain [OPEN]/[DONE] status per goal — this string feeds every downstream
    // prompt that reads the self-model (including the chief brief). Dropping
    // completion status here (bare goal text with no status) meant a goal's
    // own achieved flag was invisible everywhere the self-model is the ONLY
    // context reaching the model, letting it guess a still-open goal was done
    // from a weaker signal (a calendar event, a prior brief's wording).
    const goalsStr = Array.isArray(intention.goals) && intention.goals.length
      ? intention.goals.map((g) => `${g.achieved ? '[DONE]' : '[OPEN]'} ${g.text || g}`).join(', ')
      : '';
    const ctx = intention.context ? ` Context: ${intention.context}` : '';
    lines.push(`STATED FOCUS (week of ${wk}) — [OPEN]/[DONE] reflects the user's own checkbox, the ONLY source of truth for completion: ${goalsStr}${ctx}`);
  }

  // --- Active life context ---
  if (annotations.length) {
    lines.push(`ACTIVE CONTEXT: ${annotations.map((a) => `${a.category}: ${a.label}`).join('; ')}`);
  }

  // --- Recent daily context (the narrative the user has told NormOS) ---
  // The self-model is where these compound: over time this is what lets NormOS
  // notice "Mondays read stressful" or "you sleep worse after travel". Kept
  // recent + trimmed so the model distills patterns rather than hoarding raw logs.
  if (dayContext.length) {
    const entries = dayContext
      .slice(0, 10)
      .map((e) => `  - [${e.entry_date}] ${String(e.text).slice(0, 300)}`)
      .join('\n');
    lines.push(`RECENT DAILY CONTEXT (their own words — infer standing patterns, don't just restate):\n${entries}`);
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

  // Promote feedback signals into durable beliefs BEFORE gathering, so
  // tonight's model reflects today's dismissals/statements. Fail-soft: the
  // model still builds if promotion errors (it logs its own per-source errors).
  // The LLM statement-extraction step runs ONLY on the scheduled nightly (and
  // manual CLI) consolidation — the kind:'briefing' call inside a briefing
  // rebuild is documented as no-LLM and must stay fast, so it promotes from
  // the ledgers only.
  try {
    const promo = await require('./beliefs').promoteBeliefs({ extractStatements: kind !== 'briefing' });
    if (promo.errors.length) console.error('[consolidate] belief promotion issues:', promo.errors.join('; '));
  } catch (err) {
    console.error('[consolidate] belief promotion failed:', err.message);
  }

  const [wellbeing, health, habits, wealth, goals, experiments, findings, annotations, intentionArr, dayContext, beliefs] =
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
      require('../store/dayJournal').recent({ days: 14, limit: 14 }).catch(() => []),
      require('../store/beliefs').listActive(),
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
  const content = buildModelText({ wellbeing, health, habits, wealth, goals, experiments, findings, annotations, intention, dayContext, beliefs, generatedAt: now });

  await selfModelStore.saveModel({ content, snapshot, kind });
  return content;
}

module.exports = {
  consolidate, buildModelText,
  gatherWellbeing, gatherHealth, gatherHabits, gatherWealth, gatherFindings, gatherExperiments,
};

if (require.main === module) {
  const { pool } = require('../db');
  consolidate({ kind: 'manual' })
    .then((text) => { console.log('\n--- SELF-MODEL ---\n'); console.log(text); })
    .catch((err) => { console.error('Consolidate failed:', err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
