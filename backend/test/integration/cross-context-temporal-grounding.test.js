// Bug bash finding (screenshot report): a Cross-Domain Patterns card read
// "with your last night's context ('slept hot, twisting and turning') this
// is likely playing out again" — but that journal entry was from THREE DAYS
// earlier, not last night. Root cause: crossContext.js prepended the ENTIRE
// self-model text (built by consolidate.js, including up to 10 dated
// day-journal entries under "RECENT DAILY CONTEXT") into the Cross-Domain
// LLM prompt, and the model rewrote an old dated entry as a live, current-
// tense event.
//
// Fix: crossContext.js now builds its own durable-only profile (stable
// beliefs, confirmed/ruled-out experiments, long-term goals) from their own
// stores, never touching day_journal or the composed self-model text at
// all, plus an explicit prompt-level rule forbidding current-tense temporal
// language. These tests prove: the LLM call itself never receives the raw
// journal block or a specific dated entry; a historical relationship can
// still generate a valid insight from its aggregate numbers; durable
// beliefs/experiments/goals remain available; and existing filtering/
// persistence (supersede-then-create) is unaffected.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const llm = require('../../src/llm');
const findingsStore = require('../../src/store/findings');
const dayJournalStore = require('../../src/store/dayJournal');
const goalsStore = require('../../src/store/goals');
const experimentsStore = require('../../src/store/experiments');
const beliefsStore = require('../../src/store/beliefs');
const { generateCrossContext, buildDurableProfile } = require('../../src/intelligence/crossContext');

const ORIGINAL_GENERATE_TEXT = llm.generateText;
const STALE_JOURNAL_TEXT = 'slept hot, twisting and turning most of the night';
const createdIds = { goals: [], experiments: [], findings: [] };

async function cleanup() {
  llm.generateText = ORIGINAL_GENERATE_TEXT;
  await db.query(`DELETE FROM day_journal WHERE text = $1`, [STALE_JOURNAL_TEXT]);
  await db.query(`DELETE FROM findings WHERE type IN ('cross_context', 'sleep_impact') AND title LIKE 'TEST:%'`);
  await db.query(`DELETE FROM goals WHERE title LIKE 'TEST:%'`);
  await db.query(`DELETE FROM experiments WHERE hypothesis LIKE 'TEST:%'`);
  await db.query(`DELETE FROM beliefs WHERE dedup_key LIKE 'test-cross-context-%'`);
}

afterEach(cleanup);
after(async () => {
  await cleanup();
  await closeDb();
});

/** Two open cross-domain findings — generateCrossContext requires >=2
 *  (minRelationships default) before it will call the LLM at all. */
async function seedRelationships() {
  await findingsStore.createFinding({
    type: 'sleep_impact',
    domains: ['health', 'wellbeing'],
    title: 'TEST: Sleeping in a warm room cuts your sleep by ~40 min',
    detail: 'On nights you logged a warm room, sleep averaged 7.5h vs 8.2h on cooler nights — an 8% drop.',
    confidence: 0.8,
  });
  await findingsStore.createFinding({
    type: 'habit_split',
    domains: ['habits', 'health'],
    title: 'TEST: Cold shower days show higher HRV',
    detail: '58ms vs 46ms on non-cold-shower days.',
    confidence: 0.8,
  });
}

test('the LLM call receives NO raw day-journal block and never sees a specific dated entry, even one from days ago', async () => {
  await cleanup();
  await seedRelationships();
  // The exact scenario from the report: a dated entry from 3 days ago.
  const threeDaysAgo = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  await dayJournalStore.create({ text: STALE_JOURNAL_TEXT, entryDate: threeDaysAgo });

  let capturedSystem = null;
  let capturedPrompt = null;
  llm.generateText = async ({ system, prompt }) => {
    capturedSystem = system;
    capturedPrompt = prompt;
    return JSON.stringify({ insights: [] });
  };

  await generateCrossContext();

  assert.ok(capturedPrompt, 'expected the LLM to have been called (enough relationships were seeded)');
  assert.ok(!capturedPrompt.includes('RECENT DAILY CONTEXT'), 'the raw day-journal section header must never reach the prompt');
  assert.ok(!capturedPrompt.includes(STALE_JOURNAL_TEXT), 'the specific dated journal entry text must never reach the prompt');
  assert.ok(!capturedPrompt.includes('ACTIVE CONTEXT'), 'temporary annotation context must also be excluded');

  // Defense-in-depth: the explicit grounding rule is present regardless.
  assert.match(capturedSystem, /never write "today," "last night,"/i);
});

test('a historical relationship can still generate a valid insight from its aggregate numbers alone', async () => {
  await cleanup();
  await seedRelationships();

  llm.generateText = async () => JSON.stringify({
    insights: [{
      headline: 'Warm rooms quietly cost you sleep',
      insight: 'On nights you log a warm room, sleep tends to run about 40 minutes shorter (7.5h vs 8.2h) — a real, recurring pattern in your data, not a one-off.',
      domains: ['health', 'wellbeing'],
    }],
  });

  const result = await generateCrossContext();
  assert.equal(result.generated, 1);
  assert.match(result.insights[0].insight, /40 minutes/);

  const { rows } = await db.query(`SELECT title, detail FROM findings WHERE type = 'cross_context' AND status = 'open'`);
  assert.equal(rows.length, 1);
  assert.match(rows[0].detail, /7\.5h vs 8\.2h/);
});

test('buildDurableProfile surfaces stable beliefs, confirmed experiments, and long-term goals', async () => {
  await cleanup();
  await goalsStore.createGoal({ title: 'TEST: Reach 8h average sleep', domain: 'health', targetValue: 8, unit: 'h' });
  const expId = await experimentsStore.createExperiment({
    hypothesis: 'TEST: Cooler bedroom improves sleep duration', metric: 'health:sleep_hours', status: 'completed',
  });
  await experimentsStore.updateExperiment(expId, { verdict: 'confirmed', result: { pctChange: 0.09 } });
  await beliefsStore.upsertBelief({
    kind: 'user_statement', dedupKey: 'test-cross-context-warm-room', statement: 'They sleep worse in a warm room.', confidence: 0.8,
  });

  const profile = await buildDurableProfile();
  assert.match(profile, /LONG-TERM GOALS/);
  assert.match(profile, /Reach 8h average sleep/);
  assert.match(profile, /PROVEN ON THEM/);
  assert.match(profile, /Cooler bedroom improves sleep duration/);
  assert.match(profile, /WHAT NORMOS HAS LEARNED/);
  assert.match(profile, /They sleep worse in a warm room/);
});

test('existing cross-domain filtering (selectCrossDomain) is unaffected — still excludes wealth confounds and non-cross-domain findings', async () => {
  const { selectCrossDomain } = require('../../src/intelligence/crossContext');
  const findings = [
    { type: 'sleep_impact', domains: ['health'], title: 'kept' },
    { type: 'correlation', evidence: { crossDomain: true, a: 'wealth:spending', b: 'health:hrv' }, title: 'dropped (wealth)' },
    { type: 'correlation', evidence: { crossDomain: false }, title: 'dropped (not cross-domain)' },
    { type: 'trend', title: 'dropped (wrong type)' },
  ];
  const kept = selectCrossDomain(findings);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, 'kept');
});

test('generation still supersedes prior cross_context findings before persisting new ones', async () => {
  await cleanup();
  await seedRelationships();

  llm.generateText = async () => JSON.stringify({ insights: [{ headline: 'First', insight: 'First insight text here.', domains: ['health'] }] });
  await generateCrossContext();
  const firstRun = await db.query(`SELECT id FROM findings WHERE type = 'cross_context' AND status = 'open'`);
  assert.equal(firstRun.rows.length, 1);

  llm.generateText = async () => JSON.stringify({ insights: [{ headline: 'Second', insight: 'Second insight text here.', domains: ['health'] }] });
  await generateCrossContext();
  const secondRun = await db.query(`SELECT title FROM findings WHERE type = 'cross_context' AND status = 'open'`);
  assert.equal(secondRun.rows.length, 1, 'the old cross_context finding must be superseded, not accumulated');
  assert.equal(secondRun.rows[0].title, 'Second');
});
