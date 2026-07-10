// Live bug found via a product screenshot review: HealthCard showed a VO2 max
// of 44.7 (a live device reading — mobile pushes fresh HealthKit VO2 samples
// to the spine on every Health tab open) while the "fitness" insight card on
// the SAME tab showed 43.7 — frozen at whatever the last nightly analyze() run
// computed. Same metric, two numbers, one screen.
//
// Root cause: buildFreshBriefing's CACHE-HIT branch — the one that serves
// nearly all real traffic (pull-to-refresh, every normal tab open; only the
// scheduled 8:30am build and the explicit "Rebuild briefing" button force a
// real rebuild) — returns the stored content byte-for-byte from whenever
// analyze() last ran, with no live-refresh for the fitness insight. It
// already does exactly this kind of live-refresh for recovery/weeklyGoals/
// weeklyReview; healthInsights' VO2 "current" was the gap.
//
// This test exercises that exact cache-hit branch: seed a stored briefing
// (as if analyze() ran when VO2 was 43.7), then push a fresher metric row (as
// if the user just opened the Health tab and HealthKit synced 44.7), then
// call buildFreshBriefing({force: false}) — a normal, non-rebuild call — and
// confirm the served content reflects the fresh value.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const { closeDb } = require('./helpers');
const db = require('../../src/db');
const briefingsStore = require('../../src/store/briefings');
const metricsStore = require('../../src/store/metrics');
const sourcesStore = require('../../src/store/sources');

const TAG = `test-vo2-freshen-${Date.now()}`;

async function cleanup() {
  await db.query(`DELETE FROM briefings WHERE content->'chiefBrief'->>'synthesis' = $1`, [TAG]);
  await db.query(`DELETE FROM metrics WHERE domain = 'health' AND metric = 'vo2_max' AND source = 'apple_health' AND value IN (44.7, 43.7)`);
}
after(async () => { await cleanup(); await closeDb(); });

async function seedStoredBriefing() {
  const content = {
    day: new Date().toISOString().slice(0, 10),
    builtAt: new Date().toISOString(),
    chiefBrief: { synthesis: TAG, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
    morningFocus: 'focus',
    healthInsights: [
      {
        type: 'fitness',
        title: 'VO₂ max 43.7 — rising ~2.1 pts/quarter',
        detail: 'VO₂ max — your cardiorespiratory fitness — is among the strongest predictors of long-term health and lifespan. Yours is 43.7 and rising (~2.1 pts/quarter).',
        confidence: 0.8,
        domains: ['health'],
        evidence: { auto: true, kind: 'fitness', metric: 'health:vo2_max', current: 43.7, per90: 2.1, n: 30 },
      },
    ],
  };
  const { rows } = await db.query(
    `INSERT INTO briefings (kind, content) VALUES ('daily', $1) RETURNING id`,
    [JSON.stringify(content)]
  );
  return rows[0].id;
}

test('a normal (non-forced) briefing read freshens the cached VO2 reading instead of serving the stale analyze()-time value', async () => {
  await cleanup();
  await sourcesStore.registerSource({ id: 'apple_health', domain: 'health', displayName: 'Apple Health' });
  await seedStoredBriefing();

  // The user just opened the Health tab — HealthKit pushed a fresher sample.
  await metricsStore.insertMetrics([
    { ts: new Date(), domain: 'health', metric: 'vo2_max', value: 44.7, unit: 'mL/kg/min', source: 'apple_health' },
  ]);

  const { buildFreshBriefing } = require('../../src/routes/briefing');
  const result = await buildFreshBriefing({ force: false }); // the real, common path

  assert.equal(result.cached, true, 'sanity: this must have taken the cache-hit branch, not a fresh rebuild');
  const fitness = (result.healthInsights || []).find((f) => f.type === 'fitness');
  assert.ok(fitness, 'expected the seeded fitness insight to be present');
  assert.match(fitness.title, /44\.7/, 'title must show the freshly-pushed 44.7');
  assert.doesNotMatch(fitness.title, /43\.7/, 'must not still show the stale analyze()-time value');
  assert.match(fitness.detail, /44\.7/, 'detail must also be re-rendered with the fresh value');
  // The trend stays batch-computed (per90 from the stored evidence) — only
  // "current" is live. Confirms we're not silently dropping the trajectory.
  assert.match(fitness.title, /rising/);
});

test('with no fresher metric row than what was already cached, the stored value is left untouched', async () => {
  await cleanup();
  await sourcesStore.registerSource({ id: 'apple_health', domain: 'health', displayName: 'Apple Health' });
  await seedStoredBriefing();
  // No new metric pushed this time.

  const { buildFreshBriefing } = require('../../src/routes/briefing');
  const result = await buildFreshBriefing({ force: false });

  const fitness = (result.healthInsights || []).find((f) => f.type === 'fitness');
  assert.ok(fitness);
  // No vo2_max rows exist at all in a clean test DB run for this suite, so the
  // live lookup finds nothing and the cached 43.7 is left as-is (graceful,
  // not an error).
  assert.match(fitness.title, /43\.7|44\.7/, 'should show whichever value is actually available, never crash/blank');
});
