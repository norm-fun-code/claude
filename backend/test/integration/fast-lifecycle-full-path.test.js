// Audit fix: the fast-lifecycle bug ("25 hour fast starting tonight" kept
// reading as current after it ended) was previously proven only at the
// context-compiler/context-resolver unit level (see
// context-lifecycle-and-question-provenance.test.js's scenario 1). This
// closes the gap the audit explicitly called out: the SAME guarantee must
// hold when read through the real full brief (buildFreshBriefing), the real
// scoped chief-brief rebuild route, and the real forecast context path — not
// just the compiler/resolver functions in isolation. It also proves a
// context-compiler outage (this test environment has no live Anthropic
// access, so every real compile attempt already fails this way) cannot make
// the RAW relative-time note itself misrepresent the fast as starting
// "tonight" on a later day, since context_assertions never exists to
// enforce it structurally in that failure mode — the presentation-layer
// reanchor (intelligence/reanchor-time.js) is what protects that case.
//
// Real Postgres throughout. Dates are anchored to real wall-clock time
// (buildFreshBriefing/the scoped-rebuild route/predict.js's
// computeTodayForecast(asOf) all read `new Date()`/accept `asOf` — there is
// no fake-clock facility in this codebase's test suite), matching the
// established pattern used elsewhere for "yesterday"/"tomorrow" coverage.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const llm = require('../../src/llm');
const { closeDb, buildTestApp, authHeader } = require('./helpers');
const request = require('supertest');
const contextAssertionsStore = require('../../src/store/contextAssertions');
const annotationsStore = require('../../src/store/annotations');
const briefingsStore = require('../../src/store/briefings');
const { reanchorRelativeTime } = require('../../src/intelligence/reanchor-time');
const { localDateStr } = require('../../src/util/date');

const app = buildTestApp();
const TZ = process.env.TZ || 'America/New_York';
const ORIGINAL_GENERATE_TEXT = llm.generateText;
const TEST_MARKER = `fast-lifecycle-${Date.now()}`;
const HOUR = 3600 * 1000;

function stubChiefBriefClaimingCurrentFast() {
  llm.generateText = async ({ system } = {}) => {
    if (system && system.includes('chief of staff and data scientist')) {
      return {
        text: JSON.stringify({
          chiefBrief: {
            synthesis: `${TEST_MARKER} You're fasting for 25 hours through a busy day, so keep it light. Stay focused on your afternoon meetings.`,
            // Long enough to clear assessChiefBriefQuality's minimum-completeness
            // bar (action/risk/move >= 4 words, morningFocus >= 15 when
            // present) — a degraded attempt with no same-day prior would
            // otherwise report chiefBriefPending (chiefBrief: null) instead
            // of the neutralized/untouched synthesis these tests assert on.
            action: 'Keep meals light and simple during the fasting window today.',
            risk: 'Low blood sugar could make afternoon meetings harder to focus through.',
            move: 'Set a reminder to break the fast gently with a small snack.',
            openQuestion: '',
          },
          morningFocus: 'Stay hydrated and keep today\'s schedule light and manageable while the fasting window is still active.',
          urgentEmails: [],
        }),
        stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
      };
    }
    // Wisdom / cross-context / any other concurrent call this build makes.
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
}

// isTemporallyEligible (context-resolver.js) is DAY-granularity, not
// hour-granularity — an assertion stays eligible through the END of the
// local calendar day its effectiveEnd falls in (see that function's own doc
// comment), matching the reported bug's own day-level framing ("current
// Thursday, gone Friday"). "Ended a few hours ago" within the SAME today is
// therefore still eligible by design; the ended case below must fall on a
// PRIOR calendar day to actually be ineligible.
function endedFastWindow(now) {
  const { localDayBoundsUtc } = require('../../src/util/date');
  const effectiveEnd = new Date(localDayBoundsUtc(TZ, now).start.getTime() - 60 * 1000); // just before today started
  const effectiveStart = new Date(effectiveEnd.getTime() - 25 * HOUR);
  return { effectiveStart, effectiveEnd };
}

async function seedFastAssertion({ effectiveStart, effectiveEnd }) {
  return contextAssertionsStore.create({
    source: 'briefing_context', rawText: `${TEST_MARKER} 25 hour fast starting tonight through tomorrow`,
    assertionType: 'plan', subject: 'user', predicate: 'is fasting', objectValue: 'for 25 hours',
    domains: ['health'], concepts: ['fasting'], eventStatus: 'planned',
    effectiveStart: effectiveStart.toISOString(), effectiveEnd: effectiveEnd.toISOString(),
    confidence: 0.9, sourceAuthority: 'user', compilerVersion: '1.0.0',
  });
}

afterEach(async () => {
  llm.generateText = ORIGINAL_GENERATE_TEXT;
  await db.query(`DELETE FROM context_relations WHERE source_assertion_id IN (SELECT id FROM context_assertions WHERE raw_text LIKE $1)`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM context_assertions WHERE raw_text LIKE $1`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM annotations WHERE label LIKE $1 OR note LIKE $1`, [`%${TEST_MARKER}%`]);
  // Scenario 8's plain "add context" note (no signalKey) also lands in
  // day_journal (see routes/annotations.js's isDayContext) — it feeds
  // computeTodayForecast's dayContext exactly like the annotations table
  // does, so a leftover row here would pollute scenario 7c's call-count
  // assertion for any later run.
  await db.query(`DELETE FROM day_journal WHERE text LIKE $1`, [`%${TEST_MARKER}%`]);
  await db.query(`DELETE FROM briefings WHERE kind = 'daily'`);
});
after(async () => { await closeDb(); });

// ── Scenario 7 — full brief ──────────────────────────────────────────────
test('scenario 7a — a chiefBrief claiming "currently fasting" is neutralized by the FULL brief pipeline once the fast has genuinely ended, but left alone while it is genuinely still current', async () => {
  const now = new Date();

  // Ended yesterday (a prior calendar day) — the false "currently fasting"
  // claim must be neutralized, which (per the audit fix, item B) means it
  // can no longer ship as a displayable chiefBrief at all: a neutralized
  // field falls back to claimValidator.js's deterministic
  // groundedFallbackSentence(), which is itself degraded-quality prose and
  // must never be shown as if it were a completed brief. With no fresh
  // same-day prior seeded in this test, the correct outcome is an explicit
  // PENDING state (chiefBrief: null), not a fallback sentence that merely
  // happens not to say "fasting".
  const endedId = await seedFastAssertion(endedFastWindow(now));
  stubChiefBriefClaimingCurrentFast();
  const { buildFreshBriefing } = require('../../src/routes/briefing');
  const endedResult = await buildFreshBriefing({ force: true });
  assert.equal(endedResult?.chiefBrief, null, 'a degraded/neutralized attempt with no fresh prior must report pending, not ship fallback prose');
  assert.equal(endedResult?.chiefBriefPending, true);
  assert.equal(endedResult?.chiefBriefQuality?.status, 'degraded');
  assert.ok(
    endedResult?.chiefBriefQuality?.violatedChecks?.includes('episodic_state_overclaim'),
    `expected the original violated check to survive in safe diagnostics; got: ${JSON.stringify(endedResult?.chiefBriefQuality)}`
  );
  await contextAssertionsStore.retire(endedId, 'test cleanup');

  // Still genuinely active (started 2h ago, ends in 20h) — must survive untouched.
  await seedFastAssertion({ effectiveStart: new Date(now.getTime() - 2 * HOUR), effectiveEnd: new Date(now.getTime() + 20 * HOUR) });
  stubChiefBriefClaimingCurrentFast();
  const currentResult = await buildFreshBriefing({ force: true });
  assert.match(
    currentResult.chiefBrief.synthesis, /fasting/i,
    'a genuinely current fast must NOT be neutralized — the check is gated on real temporal eligibility, not a blanket ban on the topic'
  );
});

// ── Scenario 7 — scoped chief-brief-only rebuild ─────────────────────────
test('scenario 7b — the SAME neutralization holds through the scoped chief-brief rebuild route, not just the full build', async () => {
  const now = new Date();
  await briefingsStore.saveBriefing({
    kind: 'daily',
    content: { chiefBrief: { synthesis: 'prior', action: 'a', risk: 'r', move: 'm', openQuestion: '' }, morningFocus: 'prior mf', calendar: [], workBusy: [] },
  });

  const endedId = await seedFastAssertion(endedFastWindow(now));
  stubChiefBriefClaimingCurrentFast();
  const res = await request(app).post('/api/briefing/chief-brief/rebuild').set(authHeader()).timeout(15000);
  assert.equal(res.status, 200);
  assert.doesNotMatch(
    res.body.chiefBrief.synthesis, /fasting/i,
    `the scoped rebuild must apply the identical guard: got "${res.body.chiefBrief.synthesis}"`
  );
  await contextAssertionsStore.retire(endedId, 'test cleanup');
});

// ── Scenario 7 — forecast context ────────────────────────────────────────
test('scenario 7c — a stale annotation about the (now-ended) fast does not reach the forecast\'s context-adjustment step; a fresh one does', async () => {
  const now = new Date();
  const { start: startOfToday } = require('../../src/util/date').localDayBoundsUtc(TZ, now);

  // Stale: recorded well before today (mirrors what POST /briefing/context
  // would have persisted the evening the fast was submitted) — predict.js's
  // own `start_ts >= startOfToday` eligibility filter must exclude it.
  const staleStart = new Date(startOfToday.getTime() - 30 * HOUR);
  const { id: staleId } = await annotationsStore.createAnnotation({
    startTs: staleStart.toISOString(), endTs: new Date(staleStart.getTime() + 25 * HOUR).toISOString(),
    category: 'brief_context', label: `${TEST_MARKER} 25 hour fast starting tonight through tomorrow`,
  });

  let adjustCalls = 0;
  llm.generateText = async ({ prompt } = {}) => {
    adjustCalls += 1;
    return JSON.stringify({ note: null, downgrade: false });
  };
  const { computeTodayForecast } = require('../../src/intelligence/predict');
  await computeTodayForecast({ recovery: { score: 70, band: 'green' }, asOf: now });
  assert.equal(adjustCalls, 0, 'a stale (already-over) annotation must never reach the forecast context-adjustment call at all');
  await db.query(`DELETE FROM annotations WHERE id = $1`, [staleId]);

  // Fresh: recorded earlier today, still within today's window.
  const freshStart = new Date(Math.max(startOfToday.getTime(), now.getTime() - HOUR));
  await annotationsStore.createAnnotation({
    startTs: freshStart.toISOString(), endTs: new Date(freshStart.getTime() + 25 * HOUR).toISOString(),
    category: 'brief_context', label: `${TEST_MARKER} 25 hour fast starting tonight through tomorrow`,
  });
  adjustCalls = 0;
  await computeTodayForecast({ recovery: { score: 70, band: 'green' }, asOf: now });
  assert.ok(adjustCalls > 0, 'a genuinely current annotation must reach the forecast context-adjustment step');
});

// ── Scenario 8 — compiler outage cannot leave the raw note misreading as current ──
test('scenario 8 — a context-compiler outage cannot make the raw relative-time fast note read as starting "tonight" on a later day', async () => {
  // No mock: this environment has no live ANTHROPIC_API_KEY, so
  // compileUserContext already fails exactly like a real outage would —
  // routes/annotations.js still saves the raw annotation (non-identity-
  // bearing note; see that route's fail-open behavior for ordinary notes).
  const rawText = `${TEST_MARKER} 25 hour fast starting tonight through tomorrow`;
  const res = await request(app).post('/api/briefing/context').set(authHeader()).send({ answer: rawText });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  // No structured assertion exists to enforce the lifecycle (the compiler
  // never ran successfully) — the ONLY remaining protection is the
  // presentation-layer reanchor applied when this raw note is rendered on a
  // LATER day. Confirm it actually neutralizes the stale phrasing.
  const stored = await db.query(`SELECT label, created_at FROM annotations WHERE label = $1`, [rawText]);
  assert.equal(stored.rows.length, 1);
  const entryDate = localDateStr(TZ, stored.rows[0].created_at);
  const twoDaysLater = new Date(stored.rows[0].created_at.getTime() + 2 * 24 * HOUR);

  const rendered = reanchorRelativeTime(stored.rows[0].label, { fromDate: stored.rows[0].created_at, now: twoDaysLater, tz: TZ });
  assert.doesNotMatch(rendered, /starting tonight/i, `read two days later, this must not still say "starting tonight": got "${rendered}"`);
  assert.doesNotMatch(rendered, /\btomorrow\b/i, `"tomorrow" from the entry day must also be re-anchored: got "${rendered}"`);

  // No context_assertions row exists at all — proves this scenario is
  // genuinely exercising the compiler-failure path, not accidentally
  // succeeding some other way.
  const { rows: assertionRows } = await db.query(`SELECT id FROM context_assertions WHERE raw_text = $1`, [rawText]);
  assert.equal(assertionRows.length, 0, 'sanity: the compiler must have produced nothing structured for this note');
});
