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
const briefingsStore = require('../store/briefings');
const { extractJson } = require('../services/briefing-ai');

const DAY = 24 * 60 * 60 * 1000;
const KEY_METRICS = [
  ['wellbeing', 'mood'], ['wellbeing', 'energy'], ['wellbeing', 'focus'],
  ['health', 'sleep_hours'], ['health', 'hrv'], ['health', 'steps'],
  ['wealth', 'net_worth'], ['wealth', 'spending'],
];

function round(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
const avg = (arr) => (arr.length ? arr.reduce((s, r) => s + Number(r.value), 0) / arr.length : null);
const sum = (arr) => (arr.length ? arr.reduce((s, r) => s + Number(r.value), 0) : null);

/**
 * Roll a week's daily-aggregated rows into a single weekly number. Flow metrics
 * (spending, income — anything aggregated by 'sum') roll up as a weekly TOTAL,
 * matching the Wealth tab; stock metrics (mood, HRV, net worth) roll up as a
 * weekly AVERAGE. Averaging a flow was the bug behind the Wealth/Insights
 * spending mismatch ($6,698 total shown as a $224 daily average).
 */
function weekly(rows, metric) {
  return cat.aggFor(metric) === 'sum' ? sum(rows) : avg(rows);
}

/** Pull the week's numbers (this week vs prior week) + current findings. */
async function gatherWeek(asOf = new Date()) {
  const periodEnd = new Date(asOf);
  const periodStart = new Date(asOf.getTime() - 7 * DAY);
  const priorStart = new Date(asOf.getTime() - 14 * DAY);

  const metrics = [];
  for (const [domain, metric] of KEY_METRICS) {
    const agg = cat.aggFor(metric);
    const cur = await metricsStore.dailyAggregate({ domain, metric, from: periodStart, to: periodEnd, agg });
    const prev = await metricsStore.dailyAggregate({ domain, metric, from: priorStart, to: periodStart, agg });
    const a = weekly(cur, metric);
    const b = weekly(prev, metric);
    if (a == null) continue;
    metrics.push({
      label: cat.label(domain, metric),
      thisWeek: round(a), lastWeek: round(b),
      change: b ? round((a - b) / Math.abs(b), 3) : null,
      goodWhen: cat.goodWhen(domain, metric),
      isTotal: agg === 'sum', // so the narrative can say "total" vs "average"
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
  };
}

const SYSTEM = `You are NormOS — the user's chief of staff and personal data scientist, writing their WEEKLY REVIEW.
Be specific, honest, and concise. Use the numbers provided; never invent data. Correlations are associations, not proof of cause — say so when you lean on one.
Voice: a sharp, caring advisor who tells the truth. Return ONLY valid JSON.`;

/** Pure: assemble the review prompt from gathered context. */
function composeReview(ctx) {
  const fmtPct = (c) => (c == null ? '' : ` (${c >= 0 ? '+' : ''}${Math.round(c * 100)}% vs last week)`);
  const metricsBlock = ctx.metrics
    .map((m) => `- ${m.label}: ${m.thisWeek}${m.isTotal ? ' (weekly total)' : ' (weekly avg)'}${fmtPct(m.change)}${m.goodWhen ? ` [better when ${m.goodWhen}]` : ''}`)
    .join('\n') || '- (not enough data this week)';
  const corr = ctx.correlations.map((f) => `- ${f.title}`).join('\n') || '- none confirmed';
  const fc = ctx.forecasts.map((f) => `- ${f.title}`).join('\n') || '- none';
  const lev = ctx.leverage.map((f, i) => `${i + 1}. ${f.title}`).join('\n') || '- none';
  const ann = ctx.annotations.map((a) => `- ${a.category}: ${a.label}`).join('\n') || '- none logged';

  const prompt = `Week of ${ctx.periodStart.toISOString().slice(0, 10)} to ${ctx.periodEnd.toISOString().slice(0, 10)}.

KEY METRICS (this week's average):
${metricsBlock}

CONFIRMED RELATIONSHIPS:
${corr}

GOAL FORECASTS:
${fc}

HIGHEST-LEVERAGE ACTIONS RIGHT NOW:
${lev}

LIFE CONTEXT THIS WEEK:
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
  const ctx = await gatherWeek(asOf);
  const { system, prompt } = composeReview(ctx);

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
