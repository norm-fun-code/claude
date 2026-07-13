// Bug: the Health tab and Ask NormOS reported two different recovery scores
// for the same night (Health: 78/100, Ask: "Recovery still came in green at
// 83/100"). Root cause: chat/ask.js's text-based Ask pipeline never wired
// intelligence/recovery.js's liveRecovery() into its context at all — neither
// directly nor via the self-model text (consolidate.js's gatherHealth() never
// embeds a recovery score) — so the LLM had to invent a plausible-sounding
// number instead of citing the real one. The realtime voice tool
// (get_current_recovery) already did this correctly; recoveryContext() below
// mirrors that same liveRecovery() call, and wealthContext()'s existing
// "live computed insights" injection pattern, for the text path.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const { recoveryContext, buildPrompt, isPersonalQuestion } = require('../../src/chat/ask');
const { liveRecovery } = require('../../src/intelligence/recovery');

// recoveryScore() needs >=8 days of HRV/RHR history for a baseline (recovery.js's
// minN: 8) — without it liveRecovery() returns null and this test would pass
// trivially on "both are null" rather than proving the numbers match.
test.before(async () => {
  await db.query(`INSERT INTO sources (id, domain, display_name) VALUES ('eight_sleep', 'health', 'Eight Sleep') ON CONFLICT (id) DO NOTHING`);
  for (let i = 0; i < 14; i++) {
    const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    for (const [metric, value, unit] of [
      ['hrv', 50 + (i % 5), 'ms'],
      ['resting_hr', 58 - (i % 3), 'bpm'],
      ['sleep_hours', 7 + (i % 2) * 0.5, 'hours'],
      ['sleep_score', 78 + (i % 4), 'score'],
    ]) {
      await db.query(
        `INSERT INTO metrics (ts, domain, metric, value, unit, source)
         VALUES ($1, 'health', $2, $3, $4, 'eight_sleep')
         ON CONFLICT (ts, domain, metric, source) DO UPDATE SET value = EXCLUDED.value`,
        [`${day}T12:00:00Z`, metric, value, unit]
      );
    }
  }
});

after(async () => {
  await db.query(`DELETE FROM metrics WHERE source = 'eight_sleep'`);
  await closeDb();
});

test('recoveryContext() reports the exact same score as liveRecovery() — the single source of truth', async () => {
  const truth = await liveRecovery();
  assert.ok(truth?.score != null, 'sanity: the seeded baseline should produce a real score');

  const ctx = await recoveryContext();
  assert.ok(ctx, 'recoveryContext() should return a block when liveRecovery() has data');
  assert.match(ctx, new RegExp(`Score: ${Math.round(truth.score)}/100`), 'must cite the exact canonical score, not an invented one');
  assert.ok(ctx.includes(truth.band), 'must cite the canonical band');
});

test('recoveryContext() is injected into the Ask prompt so the LLM sees the true number', async () => {
  const ctx = await recoveryContext();
  const { prompt } = buildPrompt({ question: 'How is my recovery today?', recoveryInsight: ctx });
  assert.ok(prompt.includes('RECOVERY TODAY'), 'the prompt must contain the live recovery block');
  assert.ok(prompt.includes(ctx), 'the prompt must contain the exact recoveryContext() text verbatim');
});

test('a recovery question is treated as personal, so ask() actually fetches recoveryContext()', () => {
  assert.ok(isPersonalQuestion('how is my recovery today?'), 'recovery questions must route through the personal-question gate that triggers recoveryContext()');
});

test('buildPrompt omits the recovery block entirely when there is no data (no fabrication path)', () => {
  const { prompt } = buildPrompt({ question: 'How is my recovery today?', recoveryInsight: null });
  assert.ok(!prompt.includes('RECOVERY TODAY'), 'no recovery block should appear when recoveryContext() returned null');
});
