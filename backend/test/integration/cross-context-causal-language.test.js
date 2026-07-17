// Audit fix 4: cross-context validation used to check JSON SHAPE only — an
// LLM response could still slip a causal claim ("Magnesium causes higher
// energy") or an unsupported "do this" imperative ("keep taking it to boost
// energy") straight into a persisted finding. generateCrossContext now runs
// a deterministic causal-language guard (crossContext.js's
// hasUnsupportedCausalLanguage) over every generated insight before
// persisting it — driven here through the real generateCrossContext()
// against a real Postgres, not just the pure helper in isolation.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const llm = require('../../src/llm');
const findingsStore = require('../../src/store/findings');
const experimentsStore = require('../../src/store/experiments');
const { generateCrossContext } = require('../../src/intelligence/crossContext');

const ORIGINAL_GENERATE_TEXT = llm.generateText;

async function cleanup() {
  llm.generateText = ORIGINAL_GENERATE_TEXT;
  await db.query(`DELETE FROM findings WHERE type IN ('cross_context', 'sleep_impact', 'habit_split') AND title LIKE 'TEST:%'`);
  await db.query(`DELETE FROM experiments WHERE hypothesis LIKE 'TEST:%'`);
}
afterEach(cleanup);
after(async () => { await cleanup(); await closeDb(); });

async function seedRelationships() {
  await findingsStore.createFinding({
    type: 'sleep_impact',
    domains: ['health', 'wellbeing'],
    title: 'TEST: Sleeping in a warm room cuts your sleep by ~40 min',
    detail: 'On nights you logged a warm room, sleep averaged 7.5h vs 8.2h on cooler nights.',
    confidence: 0.8,
  });
  await findingsStore.createFinding({
    type: 'habit_split',
    domains: ['habits', 'health'],
    title: 'TEST: Magnesium nights show higher energy',
    detail: 'On magnesium nights, energy averaged 4.1/5 vs 3.3/5 on other nights.',
    confidence: 0.7,
  });
}

test('exact reproduction: "Magnesium causes higher energy. Keep taking it to boost energy." is never persisted', async () => {
  await cleanup();
  await seedRelationships();

  llm.generateText = async () => JSON.stringify({
    insights: [{
      headline: 'Magnesium causes higher energy',
      insight: 'Magnesium causes higher energy. Keep taking it to boost energy.',
      domains: ['health', 'habits'],
    }],
  });

  const result = await generateCrossContext();
  assert.equal(result.generated, 0, 'the causal/imperative insight must be rejected, not persisted');

  const { rows } = await db.query(
    `SELECT id FROM findings WHERE type = 'cross_context' AND status = 'open' AND (title ILIKE '%magnesium%' OR detail ILIKE '%magnesium%')`
  );
  assert.equal(rows.length, 0, 'no cross_context row referencing this causal claim may exist');
});

test('a purely observational insight about the SAME relationship (no causal verbs, no imperative) is persisted normally', async () => {
  await cleanup();
  await seedRelationships();

  llm.generateText = async () => JSON.stringify({
    insights: [{
      headline: 'Magnesium nights tend to track with more energy',
      insight: 'On nights you log magnesium, energy tends to run higher (4.1/5 vs 3.3/5) — an association worth testing, not a proven effect.',
      domains: ['health', 'habits'],
    }],
  });

  const result = await generateCrossContext();
  assert.equal(result.generated, 1, 'a properly hedged, observational insight must still be persisted');
  const { rows } = await db.query(`SELECT title FROM findings WHERE type = 'cross_context' AND status = 'open'`);
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, /tend to track/i);
});

test('a mix of one causal and one clean insight: only the clean one is persisted', async () => {
  await cleanup();
  await seedRelationships();

  llm.generateText = async () => JSON.stringify({
    insights: [
      { headline: 'Magnesium boosts your energy', insight: 'Magnesium boosts your energy — take it every night.', domains: ['health'] },
      { headline: 'Warm rooms tend to cost you sleep', insight: 'On nights you log a warm room, sleep tends to run about 40 minutes shorter — a recurring pattern, not a one-off.', domains: ['health', 'wellbeing'] },
    ],
  });

  const result = await generateCrossContext();
  assert.equal(result.generated, 1, 'exactly one of the two insights (the clean one) should survive');
  const { rows } = await db.query(`SELECT title FROM findings WHERE type = 'cross_context' AND status = 'open'`);
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, /warm room/i);
});

test('genuinely confirmed experiment-based recommendations ARE preserved (causal language allowed when a completed, confirmed experiment backs it)', async () => {
  await cleanup();
  await seedRelationships();
  const expId = await experimentsStore.createExperiment({
    hypothesis: 'TEST: Magnesium before bed boosts next-day energy', metric: 'wellbeing:energy', status: 'completed',
  });
  await experimentsStore.updateExperiment(expId, { verdict: 'confirmed', result: { pctChange: 0.24 } });

  llm.generateText = async () => JSON.stringify({
    insights: [{
      headline: 'Magnesium before bed boosts next-day energy',
      insight: 'Magnesium before bed boosts next-day energy — this was CONFIRMED in your own completed self-experiment (+24%). Keep taking it.',
      domains: ['health', 'habits'],
    }],
  });

  const result = await generateCrossContext();
  assert.equal(result.generated, 1, 'a claim matching a completed, CONFIRMED self-experiment must still be persisted');
  const { rows } = await db.query(`SELECT title FROM findings WHERE type = 'cross_context' AND status = 'open'`);
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, /magnesium/i);
});
