// Live bug: a daily brief narrated a single alcohol log after two clean
// nights as "third straight day" and "550% above usual" — Alcohol Thursday,
// none Friday, none Saturday, Alcohol Sunday is 1 of the last 3 local-
// calendar days, not a streak at all. Root causes fixed:
//  1. context:* tags were never excluded from the generic trend/anomaly
//     percentage engines (analyze.js's trendSkip) — now they are.
//  2. Nothing gave the brief LLM a factual recency count for a context tag —
//     routes/briefing.js now computes one (computeContextRecency) and feeds
//     it into the prompt as ground truth, with an explicit contract
//     (briefing-ai.js's CHIEF_SYSTEM) forbidding percentage/streak invention.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const metricsStore = require('../../src/store/metrics');
const sourcesStore = require('../../src/store/sources');
const { naiveToUtcIso } = require('../../src/util/date');

const app = buildTestApp();
const TZ = process.env.TZ || 'America/New_York';

function localDayString(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 864e5);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

async function seedAlcohol(pattern) {
  // pattern: array of [daysAgo, value], noon-local so it's unambiguously that
  // local calendar day regardless of the runner's own TZ (mirrors
  // routes/context.js's own noon-UTC-of-the-local-date anchoring).
  await sourcesStore.registerSource({ id: 'self_report', domain: 'health', displayName: 'Self-reported' }).catch(() => {});
  const metrics = pattern.map(([daysAgo, value]) => {
    const dayStr = localDayString(daysAgo);
    return { ts: new Date(naiveToUtcIso(`${dayStr}T12:00:00`, TZ)), domain: 'context', metric: 'alcohol', value, unit: 'bool', source: 'self_report' };
  });
  await metricsStore.insertMetrics(metrics);
}

function captureChiefPrompt(t) {
  let capturedPrompt = null;
  const original = llm.generateText;
  t.after(() => { llm.generateText = original; });
  llm.generateText = async ({ system, prompt }) => {
    if (system.includes('chief of staff and data scientist')) {
      capturedPrompt = prompt;
      return JSON.stringify({
        chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm', openQuestion: '' },
        morningFocus: 'f',
        urgentEmails: [],
      });
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
  return () => capturedPrompt;
}

afterEach(async () => {
  await db.query(`DELETE FROM metrics WHERE domain = 'context' AND metric = 'alcohol' AND ts >= now() - interval '10 days'`);
});
after(async () => { await closeDb(); });

test('Fri=0, Sat=0, Sun=1: the brief prompt reports "1 of the last 3 days", never a streak or a percentage', async (t) => {
  await seedAlcohol([[2, 0], [1, 0], [0, 1]]); // 2 days ago, yesterday, today
  const getPrompt = captureChiefPrompt(t);

  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);
  assert.equal(res.status, 200);

  const prompt = getPrompt();
  assert.ok(prompt, 'expected the chief-brief LLM call to have fired');
  assert.match(prompt, /RECENT CONTEXT TAGS/);
  assert.match(prompt, /Alcohol: logged on 1 of the last 3 days/);
  assert.doesNotMatch(prompt, /third straight day|3 straight days|3 consecutive days/i, 'must never claim a 3-day streak for a single gapped occurrence');
  assert.doesNotMatch(prompt, /alcohol[^\n]*%/i, 'must never attach a percentage to the alcohol tag');
});

test('a true 3-for-3 run correctly reports as a real consecutive streak', async (t) => {
  await seedAlcohol([[2, 1], [1, 1], [0, 1]]);
  const getPrompt = captureChiefPrompt(t);

  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);
  assert.equal(res.status, 200);

  const prompt = getPrompt();
  assert.ok(prompt);
  assert.match(prompt, /Alcohol: 3 consecutive days/);
});

// A pre-existing bogus "context:alcohol" trend/anomaly finding (from before
// this fix, when the generic engines weren't excluding context tags) must not
// survive indefinitely — analyze() supersedes ALL open auto trend/anomaly
// findings before recreating this run's set (findings.js's supersedeAuto,
// called unconditionally every run), and since computeTrends/computeAnomalies
// can never recreate a context:* finding anymore, the bogus one simply isn't
// replaced. This exercises that exact real store call.
test('the next analysis run supersedes a pre-existing bogus context-tag trend finding', async () => {
  const findingsStore = require('../../src/store/findings');
  const id = await findingsStore.createFinding({
    type: 'trend',
    domains: ['wellbeing'],
    title: 'Alcohol up 550% vs your 7d norm',
    detail: 'bogus pre-fix finding',
    evidence: { auto: true, kind: 'trend', metric: 'context:alcohol' },
  });

  await findingsStore.supersedeAuto(['trend', 'correlation', 'anomaly', 'leverage', 'forecast', 'habit_consistency', 'habit_split', 'sleep_impact', 'activity_impact', 'daytime_cardio', 'wellbeing_gap']);

  const { rows } = await db.query(`SELECT status FROM findings WHERE id = $1`, [id]);
  assert.equal(rows[0].status, 'superseded');
  await db.query(`DELETE FROM findings WHERE id = $1`, [id]);
});
