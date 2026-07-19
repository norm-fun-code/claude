// End-to-end proof (real Postgres) for the Weekly Review "two nights of
// alcohol + late meals (Wed/Thu)" bug fix: a single overnight episode
// (alcohol at 11pm Wednesday, a late meal at 12:30am Thursday — the SAME
// continuous night) is stored as two ordinary annotations, runReview()
// builds the canonical weekly event ledger from them (one episode, not
// two), and a generated response that falsely claims "two nights"/"Wed/Thu"
// is caught by claim validation, retried once, and — since the mock keeps
// returning the same false claim — degrades to neutral wording rather than
// ever shipping the false claim. Mirrors review-llm-validation.test.js's
// mocking pattern (mock llm.generateText, real DB for everything else).
const test = require('node:test');
const { afterEach } = test;
const assert = require('node:assert/strict');
const llm = require('../../src/llm');
const db = require('../../src/db');
const annotationsStore = require('../../src/store/annotations');

test.after(async () => { await db.pool.end(); });

const TEST_MARKER = `weekly-ledger-review-${Date.now()}`;
// Fixed asOf so the review period is deterministic: periodStart/periodEnd =
// [2026-07-12T12:00Z, 2026-07-19T12:00Z]. Wednesday July 15, 11pm ET =
// 2026-07-16T03:00:00Z; Thursday July 16, 12:30am ET = 2026-07-16T04:30:00Z
// — both inside the window, and (per weeklyLedger's night-grouping rule)
// the SAME physical episode: "the night of Wednesday July 15".
const ASOF = new Date('2026-07-19T12:00:00Z');

afterEach(async () => {
  await db.query(`DELETE FROM annotations WHERE label LIKE $1`, [`%${TEST_MARKER}%`]);
});

function falseTwoNightsClaim() {
  return JSON.stringify({
    headline: 'A mixed week',
    narrative: `This week had real ups and downs overall. You had two nights of alcohol and late meals this week (Wed/Thu).`,
    wins: ['Stayed consistent with workouts'],
    watchouts: ['Two nights of alcohol and late meals hurt recovery this week (Wed/Thu).'],
    focus: ['Cut back next week'],
  });
}

test('required test 6 (end-to-end): a generated "two nights"/"Wed/Thu" claim from a one-night ledger is caught, retried, and never shipped', async (t) => {
  const original = llm.generateText;
  t.after(() => { llm.generateText = original; });
  let calls = 0;
  llm.generateText = async () => { calls += 1; return falseTwoNightsClaim(); };

  await annotationsStore.createAnnotation({
    startTs: new Date('2026-07-16T03:00:00Z'), // 11pm Wed ET
    category: 'life',
    label: `Drinks with friends [${TEST_MARKER}]`,
  });
  await annotationsStore.createAnnotation({
    startTs: new Date('2026-07-16T04:30:00Z'), // 12:30am Thu ET — same continuous night
    category: 'life',
    label: `A late dinner too [${TEST_MARKER}]`,
  });

  const { runReview } = require('../../src/intelligence/review');
  const result = await runReview({ asOf: ASOF, persist: false });

  // The false claim never survives, in either field it appeared in.
  assert.doesNotMatch(result.narrative, /two nights/i);
  assert.doesNotMatch(result.narrative, /wed\/thu|wednesday and thursday/i);
  assert.ok(!result.watchouts.some((w) => /two nights/i.test(w)), 'the false watchout sentence must be stripped, not shipped');

  // A clean sentence in the SAME field survives — only the offending
  // sentence was removed, not the whole field.
  assert.match(result.narrative, /ups and downs overall/i);

  // Fields with no violation are completely untouched.
  assert.equal(result.headline, 'A mixed week');
  assert.deepEqual(result.wins, ['Stayed consistent with workouts']);

  // Proves an actual retry happened (one shape-valid initial attempt, one
  // claim-correction retry) — not just the first response being silently
  // accepted with a false claim inside it.
  assert.equal(calls, 2);
});

test('a generated response with NO event-count claim is left completely untouched (no false positive)', async (t) => {
  const original = llm.generateText;
  t.after(() => { llm.generateText = original; });
  let calls = 0;
  llm.generateText = async () => {
    calls += 1;
    return JSON.stringify({
      headline: 'A steady week',
      narrative: 'One relaxed evening with a drink and a late dinner — otherwise a calm, focused week.',
      wins: ['Consistent sleep'], watchouts: [], focus: ['Keep the streak going'],
    });
  };

  await annotationsStore.createAnnotation({
    startTs: new Date('2026-07-16T03:00:00Z'),
    category: 'life',
    label: `Drinks with friends [${TEST_MARKER}]`,
  });
  await annotationsStore.createAnnotation({
    startTs: new Date('2026-07-16T04:30:00Z'),
    category: 'life',
    label: `A late dinner too [${TEST_MARKER}]`,
  });

  const { runReview } = require('../../src/intelligence/review');
  const result = await runReview({ asOf: ASOF, persist: false });

  assert.equal(result.headline, 'A steady week');
  assert.match(result.narrative, /calm, focused week/);
  // Only ONE call — no retry was ever triggered, because there was nothing
  // to correct.
  assert.equal(calls, 1);
});
