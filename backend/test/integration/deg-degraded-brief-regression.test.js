// Required regression coverage for the recurring-degraded-first-Chief-Brief
// production bug: the first morning brief repeatedly showed only
// "Recovery is green at 81 today." — byte-for-byte
// brain/claimValidator.js's groundedFallbackSentence() — because
// notify/morning.js's warmAndNotify() called publishBriefingDraft(draft)
// BEFORE checking draft.chiefBriefQuality, and buildFreshBriefing/the scoped
// Chief Brief rebuild would happily replace a good card with a degraded one.
// The fix is the fresh-before-publish / fresh-before-replace invariant
// (notify/morning.js, routes/briefing.js) plus a mobile safeguard and a
// stepped retry ledger. This file proves the 10 scenarios required by that
// audit, each against real Postgres wherever persistence is the actual
// claim under test — a stubbed counter alone cannot prove "never persisted".
const test = require('node:test');
const { after, afterEach, before } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const briefingsStore = require('../../src/store/briefings');
const intentionsStore = require('../../src/store/intentions');
const devicesStore = require('../../src/store/devices');
const nudgesStore = require('../../src/store/nudges');
const sourcesStore = require('../../src/store/sources');
const expo = require('../../src/notify/expo');
const morning = require('../../src/notify/morning');
const briefingRoute = require('../../src/routes/briefing');
const scheduler = require('../../src/scheduler');
const morningRetryLedger = require('../../src/intelligence/morning-retry-ledger');
const briefAudio = require('../../src/services/brief-audio');
const { groundedFallbackSentence, assessChiefBriefQuality } = require('../../src/brain/claimValidator');

const app = buildTestApp();
const TEST_MARKER = `deg-regression-${Date.now()}`;
const MIN = 60 * 1000;

function chiefMeta(text) {
  return { text, stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8' };
}

// Long enough to clear assessChiefBriefQuality's minimum-completeness bar
// (synthesis >= 12 words, action/risk/move >= 4, morningFocus >= 15 when
// present) whenever a test needs a genuinely FRESH fixture.
const FULL_ACTION = 'Block a short window this morning for the highest-leverage task on the list.';
const FULL_RISK = 'Meetings could crowd out the deep work window if nothing is protected today.';
const FULL_MOVE = 'Confirm the plan for the morning before the first meeting of the day starts.';
const FULL_MORNING_FOCUS = 'Protect the first open block today for the one thing that actually moves things forward.';

function freshDraftFixture(overrides = {}) {
  const base = {
    day: new Date().toISOString().slice(0, 10),
    snapshotId: `snap_${TEST_MARKER}`,
    chiefBrief: {
      synthesis: `${TEST_MARKER} today is genuinely on track with a manageable, well-understood schedule overall, nothing urgent.`,
      action: FULL_ACTION, risk: FULL_RISK, move: FULL_MOVE, openQuestion: '',
    },
    morningFocus: FULL_MORNING_FOCUS,
  };
  const merged = { ...base, ...overrides };
  merged.chiefBriefQuality = overrides.chiefBriefQuality
    ?? assessChiefBriefQuality({ chiefBrief: merged.chiefBrief, morningFocus: merged.morningFocus }, {});
  return merged;
}

function stubPushPlumbing() {
  devicesStore.listActiveTokens = async () => ['ExponentPushToken[test]'];
  devicesStore.deactivate = async () => {};
  nudgesStore.recentlySentKeys = async () => new Set();
  expo.sendPush = async () => ({ sent: 1, invalidTokens: [] });
}

async function cleanupLedgerAndMarkers() {
  await db.query(`DELETE FROM sources WHERE id = $1`, [morningRetryLedger.LEDGER_SOURCE_ID]);
  await db.query(`DELETE FROM nudges WHERE dedup_key LIKE 'morning_routine:%' OR dedup_key LIKE 'morning_brief_push:%'`);
}

before(async () => {
  delete process.env.EIGHT_SLEEP_EMAIL;
  delete process.env.EIGHT_SLEEP_PASSWORD;
  await cleanupLedgerAndMarkers();
});

afterEach(async () => {
  llm.generateText = require('../../src/llm').generateText; // no-op; individual tests restore their own overrides via t.after
  await db.query(`DELETE FROM briefings WHERE content->'chiefBrief'->>'synthesis' LIKE $1`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM weekly_intentions WHERE week_start = $1`, [intentionsStore.weekStart()]).catch(() => {});
  await cleanupLedgerAndMarkers();
  // Several tests in this file call morning.warmAndNotify without stubbing
  // morningBuildJobs, so each leaves a REAL job row for today's local day —
  // clean up so idx_morning_build_jobs_one_active_per_day (migration 068)
  // never blocks the NEXT test's own automatic job creation.
  await db.query(`DELETE FROM morning_build_jobs WHERE local_day = CURRENT_DATE`).catch(() => {});
});

after(async () => { await closeDb(); });

// 1. (July 30 2026 incident hardening — supersedes the old DEG-task
// assertion) Exact "Recovery is green at 81 today." fallback is
// grounded_usable under the 3-tier contract (brain/publishTier.js) and IS
// persisted by the automatic path — labeled honestly, never mislabeled
// premium. This is the deterministic-fallback path the July 30 incident
// needed: a provider hard-failure assembles exactly this kind of draft (see
// briefing-ai.js's hardFailureFallback / deterministicChiefBrief), and it
// must ship as a real, safe, useful brief instead of vanishing entirely.
test('DEG 1 (superseded): the exact grounded-fallback sentence is grounded_usable and IS persisted by the automatic path, labeled honestly', async (t) => {
  const facts = { recoveryBand: 'green', recoveryScore: 81 };
  const fallbackText = groundedFallbackSentence('synthesis', facts);
  assert.equal(fallbackText, 'Recovery is green at 81 today.');

  const degradedResult = { chiefBrief: { synthesis: fallbackText, action: 'a', risk: 'r', move: 'm' } };
  const quality = assessChiefBriefQuality(degradedResult, facts);
  assert.equal(quality.status, 'degraded');
  assert.ok(quality.fallbackFields.includes('synthesis'));
  const { derivePublishTier, isPublishableTier, PUBLISH_TIER } = require('../../src/brain/publishTier');
  assert.equal(derivePublishTier(quality), PUBLISH_TIER.GROUNDED_USABLE);
  assert.ok(isPublishableTier(derivePublishTier(quality)));

  const draft = {
    day: new Date().toISOString().slice(0, 10), timezone: 'America/New_York',
    chiefBrief: degradedResult.chiefBrief, chiefBriefQuality: quality,
    publishTier: derivePublishTier(quality),
  };

  const origBuild = briefingRoute.buildFreshBriefing;
  stubPushPlumbing();
  briefingRoute.buildFreshBriefing = async ({ publish } = {}) => { assert.equal(publish, false); return draft; };
  t.after(() => { briefingRoute.buildFreshBriefing = origBuild; });
  // fallbackText carries no TEST_MARKER tag (it's the deterministic sentence
  // itself), so the shared afterEach's marker-scoped cleanup won't catch it.
  t.after(async () => { await db.query(`DELETE FROM briefings WHERE content->'chiefBrief'->>'synthesis' = $1`, [fallbackText]); });
  t.after(async () => { await db.query(`DELETE FROM morning_build_jobs WHERE local_day = CURRENT_DATE`); });

  const res = await morning.warmAndNotify({ send: true, automatic: true });
  assert.equal(res.built, true, 'a grounded_usable fallback brief must publish, not vanish');
  assert.equal(res.publishTier, 'grounded_usable');

  const { rows } = await db.query(`SELECT content FROM briefings WHERE content->'chiefBrief'->>'synthesis' = $1`, [fallbackText]);
  assert.equal(rows.length, 1, 'the grounded-fallback content is now a legitimate publish and must be persisted exactly once');
  assert.equal(rows[0].content.publishTier, 'grounded_usable', 'the row must be labeled grounded_usable, never premium_fresh');
});

// 2. (July 30 2026 incident hardening — supersedes the old DEG-task
// assertion) A degraded automatic draft that is merely UNDERFILLED (not
// factually unsafe) now publishes, TTS-prewarms, and pushes exactly once —
// the once-daily "ready" push is eligible for a grounded_usable publish too.
test('DEG 2 (superseded): an underfilled-but-safe degraded automatic draft publishes and pushes exactly once as grounded_usable', async (t) => {
  stubPushPlumbing();
  let publishCalls = 0;
  let pushCalls = 0;
  let prewarmCalls = 0;
  const degraded = freshDraftFixture({
    chiefBrief: { synthesis: 'x', action: 'a', risk: 'r', move: 'm' }, // fails the completeness bar
  });
  degraded.chiefBriefQuality = assessChiefBriefQuality({ chiefBrief: degraded.chiefBrief }, {});
  assert.equal(degraded.chiefBriefQuality.status, 'degraded');

  const origBuild = briefingRoute.buildFreshBriefing;
  const origPublish = briefingRoute.publishBriefingDraft;
  const origPrewarm = briefAudio.prewarmDaily;
  const origPush = expo.sendPush;
  briefingRoute.buildFreshBriefing = async ({ publish } = {}) => { assert.equal(publish, false); return degraded; };
  briefingRoute.publishBriefingDraft = async (draft) => {
    publishCalls += 1;
    return {
      briefingId: 'briefing-deg2', snapshotId: draft.snapshotId ?? null, snapshotVersion: draft.snapshotVersion ?? null,
      localDay: draft.day, generatedAt: new Date().toISOString(), builtAt: draft.builtAt ?? null,
      qualityStatus: draft.chiefBriefQuality?.status ?? null, readbackVerified: true,
    };
  };
  briefAudio.prewarmDaily = async () => { prewarmCalls += 1; };
  expo.sendPush = async () => { pushCalls += 1; return { sent: 1, invalidTokens: [] }; };
  t.after(() => {
    briefingRoute.buildFreshBriefing = origBuild;
    briefingRoute.publishBriefingDraft = origPublish;
    briefAudio.prewarmDaily = origPrewarm;
    expo.sendPush = origPush;
  });

  const res = await morning.warmAndNotify({ send: true, automatic: true });
  assert.equal(res.built, true, 'an underfilled-but-safe draft is grounded_usable — a genuine publish, not a discard');
  assert.equal(res.sent, 1);
  assert.equal(res.publishTier, 'grounded_usable');
  assert.equal(publishCalls, 1, 'publishBriefingDraft must be called exactly once for a grounded_usable draft');
  assert.equal(pushCalls, 1, 'grounded_usable is eligible for the once-daily ready push, exactly like premium_fresh');

  // The morning-success-marker (scheduler.js's markMorningRan) IS written on
  // this genuine terminal outcome now — reproduce the scheduler's own
  // (tier-aware) decision with the REAL nudges store.
  const { isPublishableTier } = require('../../src/brain/publishTier');
  const briefResult = { built: true, sent: 1, publishTier: 'grounded_usable' };
  const reachedTerminalOutcome = briefResult.sleepCheckIn === true
    || (briefResult.built === true && isPublishableTier(briefResult.publishTier))
    || briefResult.skipped === 'already_built_today';
  assert.equal(reachedTerminalOutcome, true, 'scheduler.js must treat a grounded_usable publish as terminal — the day is genuinely done');
});

// 3. Fresh automatic draft publishes and pushes exactly once.
test('DEG 3: a fresh automatic draft is genuinely persisted to Postgres and pushes exactly once', async (t) => {
  stubPushPlumbing();
  let pushCalls = 0;
  const fresh = freshDraftFixture();
  assert.equal(fresh.chiefBriefQuality.status, 'fresh');

  const origBuild = briefingRoute.buildFreshBriefing;
  const origPush = expo.sendPush;
  briefingRoute.buildFreshBriefing = async ({ publish } = {}) => { assert.equal(publish, false); return fresh; };
  expo.sendPush = async () => { pushCalls += 1; return { sent: 1, invalidTokens: [] }; };
  t.after(() => {
    briefingRoute.buildFreshBriefing = origBuild;
    expo.sendPush = origPush;
  });

  const res = await morning.warmAndNotify({ send: true, automatic: true });
  assert.equal(res.built, true);
  assert.equal(res.sent, 1);
  assert.equal(res.quality, 'fresh');
  assert.equal(pushCalls, 1);

  // Real persistence check — publishBriefingDraft ran for real (not stubbed).
  const { rows } = await db.query(`SELECT 1 FROM briefings WHERE content->'chiefBrief'->>'synthesis' = $1`, [fresh.chiefBrief.synthesis]);
  assert.equal(rows.length, 1, 'a fresh draft must be genuinely persisted exactly once');
});

// 4. A degraded full rebuild cannot replace an existing fresh Chief Brief.
test('DEG 4: a degraded full rebuild (buildFreshBriefing) cannot replace an existing fresh Chief Brief', async (t) => {
  const FRESH_MARKER = `${TEST_MARKER} the existing fresh synthesis that must survive a degraded rebuild attempt`;
  await db.query(
    `INSERT INTO briefings (kind, content) VALUES ('daily', $1)`,
    [JSON.stringify({
      day: new Date().toISOString().slice(0, 10),
      chiefBrief: { synthesis: FRESH_MARKER, action: FULL_ACTION, risk: FULL_RISK, move: FULL_MOVE, openQuestion: '' },
      morningFocus: FULL_MORNING_FOCUS,
      chiefBriefQuality: { status: 'fresh' },
    })]
  );

  const origGen = llm.generateText;
  t.after(() => { llm.generateText = origGen; });
  llm.generateText = async ({ system } = {}) => {
    if (system && system.includes('chief of staff and data scientist')) {
      return chiefMeta(JSON.stringify({
        chiefBrief: { synthesis: `${TEST_MARKER} degraded`, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
        morningFocus: 'mf',
      }));
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };

  const result = await briefingRoute.buildFreshBriefing({ force: true });
  assert.equal(result.chiefBrief.synthesis, FRESH_MARKER, 'the existing fresh card must be carried forward unchanged');
  assert.equal(result.chiefBriefStale, true);
});

// 5. A degraded scoped rebuild cannot replace an existing fresh Chief Brief.
test('DEG 5: a degraded scoped rebuild (POST /briefing/chief-brief/rebuild) cannot replace an existing fresh Chief Brief', async (t) => {
  const FRESH_MARKER = `${TEST_MARKER} the existing fresh synthesis that must survive a degraded scoped rebuild`;
  await db.query(
    `INSERT INTO briefings (kind, content) VALUES ('daily', $1)`,
    [JSON.stringify({
      day: new Date().toISOString().slice(0, 10),
      chiefBrief: { synthesis: FRESH_MARKER, action: FULL_ACTION, risk: FULL_RISK, move: FULL_MOVE, openQuestion: '' },
      morningFocus: FULL_MORNING_FOCUS,
      chiefBriefQuality: { status: 'fresh' },
    })]
  );

  const origGen = llm.generateText;
  t.after(() => { llm.generateText = origGen; });
  llm.generateText = async () => ({
    text: JSON.stringify({
      chiefBrief: { synthesis: `${TEST_MARKER} degraded scoped`, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
      morningFocus: 'mf',
    }),
    stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
  });

  const res = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).timeout(15000);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.chiefBrief.synthesis, FRESH_MARKER, 'the existing fresh card must be carried forward unchanged');
  assert.equal(res.body.chiefBriefStale, true);
});

// 6. (July 30 2026 incident hardening — supersedes the old DEG-task
// assertion) With no prior fresh card, an underfilled-but-safe attempt (no
// claim violation, just too short) now publishes as grounded_usable rather
// than reporting pending — a harmless word-count miss must not erase the
// entire morning experience.
test('DEG 6 (superseded): with no prior fresh card, an underfilled-but-safe attempt publishes as grounded_usable, not pending', async (t) => {
  const origGen = llm.generateText;
  t.after(() => { llm.generateText = origGen; });
  llm.generateText = async ({ system } = {}) => {
    if (system && system.includes('chief of staff and data scientist')) {
      return chiefMeta(JSON.stringify({
        chiefBrief: { synthesis: `${TEST_MARKER} too short`, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
        morningFocus: 'mf',
      }));
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };

  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.chiefBrief, 'an underfilled-but-safe attempt is grounded_usable — it must publish');
  assert.equal(res.body.chiefBriefPending, false);
  assert.equal(res.body.publishTier, 'grounded_usable');
  assert.doesNotMatch(JSON.stringify(res.body), /Recovery is (green|yellow|red) at \d+ today\./, 'the deterministic fallback sentence must never appear when the model DID return real (if short) prose');
});

// 7. Original violated check IDs survive in safe diagnostic metadata after
// neutralization.
test('DEG 7: the original violated check name survives in chiefBriefQuality diagnostics after neutralization', async (t) => {
  await intentionsStore.saveIntention({ goals: [{ text: `${TEST_MARKER} Ship the Q3 report`, achieved: false }] });
  t.after(async () => { await db.query(`DELETE FROM weekly_intentions WHERE week_start = $1`, [intentionsStore.weekStart()]); });
  const { rows: [{ now: baselineAt }] } = await db.query(`SELECT now() AS now`);
  // Untagged (no TEST_MARKER) — this row's whole purpose is to be an opaque
  // "some prior row exists" fixture for THIS test's diagnostics-survival
  // assertion, so the shared afterEach's TEST_MARKER-scoped cleanup won't
  // touch it. Since Chief Brief regression fix, store/briefings.js's
  // resolveLastGoodChiefBrief treats ANY structurally-usable, non-pending
  // chiefBrief as last-known-good REGARDLESS of that row's own quality
  // verdict (by design — that's the fix for a second consecutive failure
  // losing already-carried-forward content) — so this placeholder (and
  // whatever row this test's own scoped rebuild below saves) must be
  // explicitly deleted afterward, or later tests in this file that assume
  // "no prior card exists" would incorrectly see it as last-good.
  t.after(async () => { await db.query(`DELETE FROM briefings WHERE kind = 'daily' AND generated_at >= $1`, [baselineAt]); });
  await db.query(
    `INSERT INTO briefings (kind, content) VALUES ('daily', $1)`,
    [JSON.stringify({ chiefBrief: { synthesis: 'prior', action: 'a', risk: 'r', move: 'm' }, morningFocus: 'prior mf' })]
  );

  const origGen = llm.generateText;
  t.after(() => { llm.generateText = origGen; });
  llm.generateText = async () => ({
    text: JSON.stringify({
      chiefBrief: { synthesis: `${TEST_MARKER} the Q3 report is done — great work wrapping that up`, action: FULL_ACTION, risk: FULL_RISK, move: FULL_MOVE, openQuestion: '' },
      morningFocus: FULL_MORNING_FOCUS,
    }),
    stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
  });

  const res = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).timeout(15000);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.chiefBriefQuality, 'the response must carry the quality diagnostics for this attempt');
  assert.equal(res.body.chiefBriefQuality.status, 'degraded');
  assert.ok(
    res.body.chiefBriefQuality.violatedChecks?.includes('goal_completion'),
    `expected the original violated check to survive; got: ${JSON.stringify(res.body.chiefBriefQuality)}`
  );
  // Safe diagnostics only — never the generated prose itself.
  assert.doesNotMatch(JSON.stringify(res.body.chiefBriefQuality), /Q3 report is done/);
});

// 8. The scheduler retries rejected drafts according to the bounded stepped
// schedule (5min / 15min / 30min).
test('DEG 8: the retry ledger applies a bounded STEPPED backoff (5min, 15min, 30min) across successive attempts', async () => {
  const base = Date.now();
  const asOf = (offsetMs) => new Date(base + offsetMs);

  // Attempt 1 recorded -> next retry (attempt 2) must wait ~5 minutes.
  await morningRetryLedger.recordAttempt({ asOf: asOf(0) });
  let decision = await morningRetryLedger.canAttempt({ asOf: asOf(4 * MIN) });
  assert.equal(decision.allowed, false, 'before the 5-minute first-retry step elapses, another attempt must not be allowed');
  decision = await morningRetryLedger.canAttempt({ asOf: asOf(6 * MIN) });
  assert.equal(decision.allowed, true, 'after the 5-minute first-retry step elapses, a retry must be allowed');

  // Attempt 2 recorded -> next retry (attempt 3) must wait ~15 minutes.
  await morningRetryLedger.recordAttempt({ asOf: asOf(6 * MIN) });
  decision = await morningRetryLedger.canAttempt({ asOf: asOf(6 * MIN + 10 * MIN) });
  assert.equal(decision.allowed, false, 'before the 15-minute second-retry step elapses, another attempt must not be allowed');
  decision = await morningRetryLedger.canAttempt({ asOf: asOf(6 * MIN + 16 * MIN) });
  assert.equal(decision.allowed, true, 'after the 15-minute second-retry step elapses, a retry must be allowed');

  // Attempt 3 recorded -> next retry (attempt 4, past the configured steps)
  // must reuse the LAST step (~30 minutes), not grow unbounded.
  const t3 = base + 6 * MIN + 16 * MIN;
  await morningRetryLedger.recordAttempt({ asOf: new Date(t3) });
  decision = await morningRetryLedger.canAttempt({ asOf: new Date(t3 + 20 * MIN) });
  assert.equal(decision.allowed, false, 'before the 30-minute later-retry step elapses, another attempt must not be allowed');
  decision = await morningRetryLedger.canAttempt({ asOf: new Date(t3 + 31 * MIN) });
  assert.equal(decision.allowed, true, 'after the 30-minute later-retry step elapses, a retry must be allowed');
});

// 9. The existing final Eight Sleep readiness gate remains intact.
test('DEG 9: the final Eight Sleep readiness gate still discards a FRESH draft entirely when the user returns to bed', async (t) => {
  process.env.EIGHT_SLEEP_EMAIL = 'test@example.com';
  process.env.EIGHT_SLEEP_PASSWORD = 'pw';
  t.after(() => { delete process.env.EIGHT_SLEEP_EMAIL; delete process.env.EIGHT_SLEEP_PASSWORD; });
  stubPushPlumbing();

  const fresh = freshDraftFixture({ chiefBrief: { synthesis: `${TEST_MARKER} nine today is genuinely on track with a manageable, well-understood schedule overall.`, action: FULL_ACTION, risk: FULL_RISK, move: FULL_MOVE, openQuestion: '' } });
  assert.equal(fresh.chiefBriefQuality.status, 'fresh', 'sanity: this draft would have been publishable on its own quality merits');

  const sleepReadiness = require('../../src/intelligence/sleep-readiness');
  const origBuild = briefingRoute.buildFreshBriefing;
  const origReadiness = sleepReadiness.getMorningSleepReadiness;
  briefingRoute.buildFreshBriefing = async ({ publish } = {}) => { assert.equal(publish, false); return fresh; };
  sleepReadiness.getMorningSleepReadiness = async () => ({ ready: false, reason: 'session_active', evidence: { trigger: 'final_gate' } });
  t.after(() => {
    briefingRoute.buildFreshBriefing = origBuild;
    sleepReadiness.getMorningSleepReadiness = origReadiness;
  });

  const res = await morning.warmAndNotify({ send: true, automatic: true });
  assert.equal(res.built, false);
  assert.equal(res.skipped, 'final_gate_failed');
  assert.equal(res.reason, 'session_active');

  const { rows } = await db.query(`SELECT 1 FROM briefings WHERE content->'chiefBrief'->>'synthesis' = $1`, [fresh.chiefBrief.synthesis]);
  assert.equal(rows.length, 0, 'the readiness gate must discard even a quality-fresh draft entirely — nothing persisted');
});

// 10. (July 30 2026 incident hardening — supersedes the old "must never
// render" premise) A confident-but-false completion claim, produced with no
// prior fresh card to fall back on, is now NEUTRALIZED (the false sentence
// rewritten to the true open state) and published as grounded_usable —
// required scenario 8: "a factual contradiction is removed and never
// published" means the CONTRADICTION never ships, not that the whole
// morning experience is erased over a fixable false sentence.
test('DEG 10 (superseded): a confident-but-false claim with no prior fresh card is neutralized and published as grounded_usable — the contradiction itself never renders', async (t) => {
  // Goal text needs enough substantive overlap with the false-claim sentence
  // for the word-overlap completion check to fire (a known, pre-existing
  // limitation of the >=60%-significant-word-overlap heuristic: a short
  // goal whose only content word is generic, e.g. "Finish the migration",
  // can fall under threshold since the sentence naturally omits the goal's
  // own leading verb — not something this task's scope covers fixing).
  await intentionsStore.saveIntention({ goals: [{ text: `${TEST_MARKER} Finish the Q3 database migration project`, achieved: false }] });
  t.after(async () => { await db.query(`DELETE FROM weekly_intentions WHERE week_start = $1`, [intentionsStore.weekStart()]); });

  const origGen = llm.generateText;
  t.after(() => { llm.generateText = origGen; });
  const FALSE_CLAIM = `${TEST_MARKER} the Q3 database migration project is fully done and shipped`;
  llm.generateText = async ({ system } = {}) => {
    if (system && system.includes('chief of staff and data scientist')) {
      return chiefMeta(JSON.stringify({
        chiefBrief: { synthesis: FALSE_CLAIM, action: FULL_ACTION, risk: FULL_RISK, move: FULL_MOVE, openQuestion: '' },
        morningFocus: FULL_MORNING_FOCUS,
      }));
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };

  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.chiefBrief, 'the neutralized result is a real, factually-safe brief — it must publish, not vanish as pending');
  assert.equal(res.body.chiefBriefPending, false);
  assert.equal(res.body.publishTier, 'grounded_usable', 'a neutralized contradiction publishes as grounded_usable, never labeled premium/fresh');
  assert.doesNotMatch(JSON.stringify(res.body), /is fully done and shipped/, 'the CONTRADICTION ITSELF must never appear anywhere in the response — it must have been rewritten to the true open state');

  const { rows } = await db.query(`SELECT content FROM briefings WHERE content->'chiefBrief'->>'action' = $1 AND content->>'publishTier' = 'grounded_usable' ORDER BY generated_at DESC LIMIT 1`, [FULL_ACTION]);
  assert.equal(rows.length, 1, 'the neutralized (rewritten) brief must be persisted exactly once, labeled grounded_usable');
  assert.doesNotMatch(rows[0].content.chiefBrief.synthesis, /is fully done and shipped/, 'the false claim must never be persisted verbatim — only the neutralized rewrite');
});
