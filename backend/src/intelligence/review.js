// Weekly review — the reflective layer. Steps back from daily findings and
// writes a "board of directors" briefing: how the week went, what drove it, and
// the single focus for next week. Provider-agnostic (uses the configured LLM,
// e.g. Claude). Run on a weekly schedule (`npm run review`) or POST /api/review/run.
require('dotenv').config();
const llm = require('../llm');
const cat = require('./catalog');
const metricsStore = require('../store/metrics');
const findingsStore = require('../store/findings');
const annotationsStore = require('../store/annotations');
const intentionsStore = require('../store/intentions');
const briefingsStore = require('../store/briefings');
const { extractJson } = require('../services/briefing-ai');

const DAY = 24 * 60 * 60 * 1000;
const KEY_METRICS = [
  ['wellbeing', 'mood'], ['wellbeing', 'energy'], ['wellbeing', 'focus'],
  ['health', 'sleep_hours'], ['health', 'hrv'], ['health', 'steps'],
  ['wealth', 'net_worth'], ['wealth', 'spending'], ['wealth', 'spending_discretionary'],
];

function round(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
const avg = (arr) => (arr.length ? arr.reduce((s, r) => s + Number(r.value), 0) / arr.length : null);
const sum = (arr) => (arr.length ? arr.reduce((s, r) => s + Number(r.value), 0) : null);
const last = (arr) => (arr.length ? Number(arr[arr.length - 1].value) : null);

// Balance-style snapshots where the LATEST value is the meaningful weekly number
// (a 7-day average of net worth is misleading — you want today's figure, like
// the Wealth tab shows).
const LATEST_METRICS = new Set(['net_worth', 'assets', 'liabilities', 'cash', 'investments', 'weight', 'body_fat']);

/**
 * Roll a week's daily-aggregated rows into a single weekly number:
 *  - Flow metrics (spending/income — aggregated by 'sum'): weekly TOTAL.
 *  - Snapshot balances (net worth, weight, …): the LATEST value, not an average.
 *  - Everything else (mood, HRV, sleep, focus): weekly AVERAGE.
 * Averaging a flow was the old Wealth/Insights spending mismatch; averaging net
 * worth was similarly misleading.
 */
function weekly(rows, metric) {
  if (cat.aggFor(metric) === 'sum') return sum(rows);
  if (LATEST_METRICS.has(metric)) return last(rows);
  return avg(rows);
}

function rollupKind(metric) {
  if (cat.aggFor(metric) === 'sum') return 'total';
  if (LATEST_METRICS.has(metric)) return 'latest';
  return 'avg';
}

const NIGHT_SOURCES = ['eight_sleep', 'eight_sleep_baseline'];
const SOURCE_LOCK = { hrv: NIGHT_SOURCES, resting_hr: NIGHT_SOURCES };

/** Pull the week's numbers (this week vs prior week) + current findings. */
async function gatherWeek(asOf = new Date()) {
  const periodEnd = new Date(asOf);
  const periodStart = new Date(asOf.getTime() - 7 * DAY);
  const priorStart = new Date(asOf.getTime() - 14 * DAY);

  const metrics = [];
  for (const [domain, metric] of KEY_METRICS) {
    const agg = cat.aggFor(metric);
    const sources = SOURCE_LOCK[metric] ?? null;
    const aggFn = (opts) => sources
      ? metricsStore.dailyAggregatePreferSource({ ...opts, agg, sources })
      : metricsStore.dailyAggregate({ ...opts, agg, excludeSource: 'seed' });
    const cur = await aggFn({ domain, metric, from: periodStart, to: periodEnd });
    const prev = await aggFn({ domain, metric, from: priorStart, to: periodStart });
    const a = weekly(cur, metric);
    const b = weekly(prev, metric);
    if (a == null) continue;
    const kind = rollupKind(metric);
    metrics.push({
      label: cat.label(domain, metric),
      thisWeek: round(a), lastWeek: round(b),
      change: b ? round((a - b) / Math.abs(b), 3) : null,
      goodWhen: cat.goodWhen(domain, metric),
      rollup: kind, // 'total' | 'latest' | 'avg' — how this week's number was derived
      isTotal: kind === 'total', // back-comp
    });
  }

  const open = await findingsStore.listFindings({ status: 'open', limit: 60 });
  return {
    periodStart, periodEnd, metrics,
    correlations: open.filter((f) => f.type === 'correlation').slice(0, 8),
    forecasts: open.filter((f) => f.type === 'forecast'),
    leverage: open
      .filter((f) => f.type === 'leverage')
      .sort((x, y) => (x.evidence?.rank ?? 9) - (y.evidence?.rank ?? 9))
      .slice(0, 5),
    annotations: await annotationsStore.listAnnotations({ from: periodStart, limit: 20 }),
    // ONLY the check-in that governed THIS review week — the intention whose
    // week_start matches the period being reviewed. A rolling 14-day pull grabbed
    // the prior week's check-in too, so the review claimed wins "across both
    // check-ins" and cited goals (e.g. Steffan convo, CF&S → DIP) from two weeks
    // back. weekStart(periodStart) is the Sunday that opened the reviewed week.
    intentions: await intentionsStore
      .intentionForWeek(intentionsStore.weekStart(periodStart))
      .then((it) => (it ? [it] : []))
      .catch(() => []),
  };
}

const SYSTEM = `You are NormOS — the user's chief of staff and personal data scientist, writing their WEEKLY REVIEW.
Be specific, honest, and concise. Use the numbers provided; never invent data. Correlations are associations, not proof of cause — say so when you lean on one.
Voice: a sharp, caring advisor who tells the truth. Return ONLY valid JSON.`;

/** Pure: assemble the review prompt from gathered context. */
function composeReview(ctx) {
  const fmtPct = (c) => (c == null ? '' : ` (${c >= 0 ? '+' : ''}${Math.round(c * 100)}% vs last week)`);
  const KIND_LABEL = { total: ' (weekly total)', latest: ' (current/latest)', avg: ' (weekly avg)' };
  const metricsBlock = ctx.metrics
    .map((m) => `- ${m.label}: ${m.thisWeek}${KIND_LABEL[m.rollup] || (m.isTotal ? ' (weekly total)' : ' (weekly avg)')}${fmtPct(m.change)}${m.goodWhen ? ` [better when ${m.goodWhen}]` : ''}`)
    .join('\n') || '- (not enough data this week)';
  const corr = ctx.correlations.map((f) => `- ${f.title}`).join('\n') || '- none confirmed';
  const fc = ctx.forecasts.map((f) => `- ${f.title}`).join('\n') || '- none';
  const lev = ctx.leverage.map((f, i) => `${i + 1}. ${f.title}`).join('\n') || '- none';
  const ann = ctx.annotations.length
    ? ctx.annotations.map((a) => {
        const day = new Date(a.start_ts).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        return `- ${day}: ${a.category}: ${a.label}`;
      }).join('\n')
    : '- none logged';
  const intentions = (ctx.intentions || [])
    .map((it) => {
      const g = Array.isArray(it.goals) && it.goals.length ? ` Focus goals: ${intentionsStore.formatGoals(it.goals)}.` : '';
      const c = it.context ? ` Context: ${it.context}` : '';
      return `-${g}${c}`.trim();
    })
    .filter((s) => s !== '-')
    .join('\n') || '- none set';

  const prompt = `Week of ${ctx.periodStart.toISOString().slice(0, 10)} to ${ctx.periodEnd.toISOString().slice(0, 10)}.

KEY METRICS (each tagged how it's rolled up — total / current / average):
${metricsBlock}

CONFIRMED RELATIONSHIPS:
${corr}

GOAL FORECASTS:
${fc}

HIGHEST-LEVERAGE ACTIONS RIGHT NOW:
${lev}

THEIR STATED FOCUS & LIFE CONTEXT (from THIS week's Sunday check-in only — judge the week against THESE goals; do not reference prior weeks' goals or "both check-ins"):
${intentions}

LIFE CONTEXT (annotations) THIS WEEK:
${ann}

Write the weekly review as JSON with EXACTLY:
{
  "headline": "one punchy sentence capturing the week",
  "narrative": "2-3 short paragraphs: what happened, what drove it (cite a relationship/number), and the honest read",
  "wins": ["1-3 specific wins, with numbers"],
  "watchouts": ["1-3 specific risks or declines, with numbers"],
  "focus": ["the single most important focus for next week, plus at most one more"]
}`;
  return { system: SYSTEM, prompt };
}

async function runReview({ asOf = new Date(), persist = true } = {}) {
  // Measure outcomes for recommendations surfaced in the last 10 days before
  // generating the review, so the "what I tried" data is ready for the prompt.
  try {
    const { measureOutcomes } = require('../store/recommendations');
    const measured = await measureOutcomes(10);
    if (measured > 0) console.log(`[review] measured ${measured} recommendation outcome(s)`);
  } catch (err) {
    console.error('[review] outcome measurement failed:', err.message);
  }

  const ctx = await gatherWeek(asOf);
  const { system: baseSystem, prompt } = composeReview(ctx);

  // Prepend the self-model so the review writer knows the full person, not just
  // this week's numbers. Falls back to the base system if no model exists yet.
  let system = baseSystem;
  try {
    const selfModelText = await require('../store/selfModel').latestModelText();
    if (selfModelText) system = `${baseSystem}\n\n${selfModelText}`;
  } catch { /* non-critical */ }

  let content;
  try {
    const text = await llm.generateText({ system, prompt, temperature: 0.4, maxTokens: 1500 });
    content = extractJson(text) || { headline: 'Weekly review', narrative: text, wins: [], watchouts: [], focus: [] };
  } catch (err) {
    console.error('[review] generation failed:', err.message);
    content = {
      headline: 'Weekly review (numbers only)',
      narrative: `Couldn't reach the model (${err.message}). Here are the week's numbers to review yourself.`,
      wins: [], watchouts: [], focus: [],
    };
  }
  content.metrics = ctx.metrics; // always attach the raw stats

  let saved = null;
  if (persist) {
    saved = await briefingsStore.saveBriefing({
      kind: 'weekly', content, periodStart: ctx.periodStart, periodEnd: ctx.periodEnd,
    });
  }
  return { ...content, id: saved?.id, generatedAt: saved?.generated_at };
}

module.exports = { runReview, gatherWeek, composeReview };

if (require.main === module) {
  const { pool } = require('../db');
  runReview()
    .then((r) => console.log(`Weekly review: ${r.headline}\n\n${r.narrative}`))
    .catch((err) => { console.error('Review failed:', err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
