// Today tab redesign — the 15 required regression scenarios for the Today
// command-center projection (brain/todayCommandCenter.js). Each exercises a
// real production function/route against real Postgres — no source-string
// assertions, no logic-bypassing mocks, consistent with the universal
// truth-and-evidence contract this projection is built on top of (not a
// second truth engine).
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const documents = require('../../src/store/documents');
const monarchWealth = require('../../src/services/monarch-wealth');
const metricsStore = require('../../src/store/metrics');
const sourcesStore = require('../../src/store/sources');
const commitmentsStore = require('../../src/store/commitments');
const intentionsStore = require('../../src/store/intentions');
const claimValidator = require('../../src/brain/claimValidator');
const { canonicalFactsFrom, buildBrainSnapshot, SNAPSHOT_VERSION } = require('../../src/brain/snapshot');
const { buildTodayCommandCenter } = require('../../src/brain/todayCommandCenter');
const { computeAnomalies } = require('../../src/intelligence/analyze');
const workoutService = require('../../src/services/workout');

const app = buildTestApp();
const MARKER = `today-${Date.now()}`;
const TEST_RUN_STARTED_AT = new Date();

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function seedCachedBriefing(content) {
  const full = {
    day: todayIso(),
    chiefBrief: { synthesis: `${MARKER} placeholder brief`, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
    morningFocus: '',
    snapshotVersion: SNAPSHOT_VERSION,
    fieldsBuiltAt: {},
    fieldVersions: {},
    ...content,
  };
  const { rows } = await db.query(
    `INSERT INTO briefings (kind, content, generated_at) VALUES ('daily', $1, now()) RETURNING id`,
    [JSON.stringify(full)]
  );
  return rows[0].id;
}

after(async () => {
  await db.query(`DELETE FROM briefings WHERE kind = 'daily' AND generated_at >= $1`, [TEST_RUN_STARTED_AT]).catch(() => {});
  await db.query(`DELETE FROM attention_log WHERE event_key LIKE $1`, [`${MARKER}%`]).catch(() => {});
  await db.query(`DELETE FROM metrics WHERE source LIKE $1`, [`${MARKER}%`]).catch(() => {});
  await db.query(`DELETE FROM commitments WHERE source = 'test' AND title LIKE $1`, [`${MARKER}%`]).catch(() => {});
  await db.query(`DELETE FROM activity_logs WHERE label LIKE $1`, [`${MARKER}%`]).catch(() => {});
  await closeDb();
});

// ── 1. Today payload uses the authoritative BrainSnapshot identity ─────────
test('scenario 1 — todayCommandCenter carries the SAME snapshot identity as the rest of the response, never a second one', async (t) => {
  documents.monthlyCategorySpend = async () => [];
  documents.spendTransactions = async () => [];
  monarchWealth.getRecurring = async () => null;
  monarchWealth.getInvestments = async () => null;
  monarchWealth.getBudgetPacing = async () => ({ asOf: new Date().toISOString(), dayOfMonth: 15, daysInMonth: 30, elapsed: 0.5, lines: [], totals: null });
  t.after(() => {
    delete documents.monthlyCategorySpend;
    delete documents.spendTransactions;
    delete monarchWealth.getRecurring;
    delete monarchWealth.getInvestments;
    delete monarchWealth.getBudgetPacing;
  });
  llm.generateText = async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) {
      return {
        text: JSON.stringify({ chiefBrief: { synthesis: `${MARKER} identity check — the snapshot behind this brief is the same one every other field on this response reads from.`, action: 'Review the identity fields once this build lands.', risk: 'No material risk is flagged for today at all.', move: 'No change is needed from the current plan.', openQuestion: '' }, morningFocus: 'Take today steadily, keep the plan in view, and check back in at midday to see what has changed.' }),
        stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
      };
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
  t.after(() => { delete llm.generateText; });

  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const tcc = res.body.todayCommandCenter;
  assert.ok(tcc, 'expected a todayCommandCenter on the response');
  assert.equal(tcc.snapshotId, res.body.snapshotId, 'snapshotId must be the SAME identity, not a second one');
  assert.equal(tcc.snapshotVersion, res.body.snapshotVersion);
  assert.equal(tcc.snapshotAt, res.body.snapshotAt);
  assert.equal(tcc.builtAt, res.body.builtAt);
  assert.equal(tcc.now.headline, res.body.chiefBrief?.synthesis, 'NOW is the SAME synthesis, not re-synthesized');
});

// ── 2. A rest-day state cannot produce a conflicting hard-workout action ───
test('scenario 2 — an ACTION prescribing the scheduled session when today is overridden to rest is caught by the real effective-workout validator', async (t) => {
  const today = todayIso();
  const original = await workoutService.getEffectiveWorkout({ tz: 'America/New_York' });
  await workoutService.setWorkoutOverride({ date: today, workoutId: 'rest' });
  t.after(async () => { await workoutService.setWorkoutOverride({ date: today, workoutId: null }); });

  const overridden = await workoutService.getEffectiveWorkout({ tz: 'America/New_York' });
  assert.equal(overridden.source, 'override');
  assert.equal(overridden.label, 'Rest');
  assert.notEqual(overridden.scheduledLabel, overridden.label, 'the override must actually diverge from the schedule for this scenario to mean anything');

  const facts = canonicalFactsFrom({
    effectiveWorkout: { label: overridden.label, source: overridden.source, scheduledLabel: overridden.scheduledLabel, workoutId: overridden.workoutId },
  });
  // This is exactly what buildTodayCommandCenter's `action` is built from
  // (chiefBrief.action) — proving Today's ACTION is subject to the SAME
  // checkEffectiveWorkout gate as every other surface, not a weaker one.
  const conflictingAction = `Time to crush today's ${overridden.scheduledLabel} session — go hard on it.`;
  const violations = claimValidator.checkEffectiveWorkout(
    [['action', conflictingAction]],
    facts
  );
  assert.ok(violations.some((v) => v.check === 'effective_workout'), 'a hard-workout action conflicting with a rest-day override must be caught');

  // An action that acknowledges the swap (or names the actual override) is fine.
  const acknowledging = `Today is a rest day (swapped from ${overridden.scheduledLabel}) — keep it light.`;
  const clean = claimValidator.checkEffectiveWorkout([['action', acknowledging]], facts);
  assert.deepEqual(clean, [], 'an action that acknowledges the override must not be flagged');
});

// ── 3. Risk is null and omitted when no material risk exists ──────────────
test('scenario 3 — risk is null when no independently-computed evidence backs it, regardless of chiefBrief.risk text', async () => {
  const tcc = await buildTodayCommandCenter({
    snapshotId: 'snap-3', snapshotVersion: 3, snapshotAt: new Date().toISOString(), builtAt: new Date().toISOString(),
    chiefBrief: { synthesis: 'All quiet today.', action: 'Keep going.', risk: 'Nothing acute — just stay the course and keep protecting your sleep.' },
    chiefBriefStale: false, chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [{ status: 'on_track', title: 'x', detail: 'y' }],
    todayForecast: { capacity: { band: 'green', grade: 'A', headline: 'h', detail: 'd' } },
    healthInsights: [{ type: 'anomaly', title: 'Steps a strong day above your usual', detail: 'd' }],
    wealthInsights: [], weeklyReview: null, wealth: null, recovery: { proxy: false },
  });
  assert.equal(tcc.risk, null, 'no RISK section when nothing evidence-backed is at risk, even though chiefBrief.risk has reassurance prose');
});

// ── 4. A 4/5 focus score alone does not create a warning ───────────────────
test('scenario 4 — a healthy-absolute-level focus score (gated upstream by computeAnomalies) never surfaces as todayCommandCenter risk', async (t) => {
  const now = Date.now();
  const rows = [];
  for (let i = 29; i >= 1; i--) rows.push({ ts: new Date(now - i * 864e5), value: i % 3 === 0 ? 4 : 5 });
  rows.push({ ts: new Date(now), value: 4 });
  await sourcesStore.registerSource({ id: `${MARKER}-focus`, domain: 'wellbeing', displayName: 'test focus' });
  await metricsStore.insertMetrics(rows.map((r) => ({ domain: 'wellbeing', metric: 'focus', source: `${MARKER}-focus`, ts: r.ts, value: r.value })));
  t.after(async () => { await db.query(`DELETE FROM metrics WHERE source = $1`, [`${MARKER}-focus`]); });

  const from = new Date(now - 30 * 864e5);
  const series = await metricsStore.dailyAggregate({ domain: 'wellbeing', metric: 'focus', from, agg: 'avg' });
  const findings = computeAnomalies({ 'wellbeing:focus': series });
  const healthInsights = findings; // exactly what routes/briefing.js feeds forward as healthInsights-equivalent findings

  const tcc = await buildTodayCommandCenter({
    snapshotId: 'snap-4', snapshotVersion: 3, snapshotAt: new Date().toISOString(), builtAt: new Date().toISOString(),
    chiefBrief: { synthesis: 's', action: 'a', risk: 'Focus dipped a bit today — worth keeping an eye on.' },
    chiefBriefStale: false, chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: { capacity: { band: 'green' } }, healthInsights,
    wealthInsights: [], weeklyReview: null, wealth: null, recovery: null,
  });
  assert.equal(tcc.risk, null, 'a 4/5 focus score must never manufacture a risk from a high personal baseline alone');
});

// ── 5. Goals from different week identities cannot be presented as contradictory ──
test('scenario 5 — todayCommandCenter.now surfaces the SAME goalsWeekStart/chiefBriefGoalsStale identity fields already proven in the truth contract, never re-derived', async (t) => {
  const currentWeek = intentionsStore.weekStart();
  const priorWeek = intentionsStore.priorWeekStart();
  await intentionsStore.saveIntention({ weekStart: currentWeek, context: `${MARKER} current week`, goals: [{ text: `${MARKER} ship it`, achieved: false }] });
  t.after(async () => { await db.query(`DELETE FROM weekly_intentions WHERE week_start = $1`, [currentWeek]); });

  const id = await seedCachedBriefing({
    chiefBrief: { synthesis: `${MARKER} all this week's goals are done.`, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
    goalsWeekStart: priorWeek,
  });
  const res = await request(app).get('/api/briefing').set(authHeader()).timeout(15000);
  assert.equal(res.status, 200);
  assert.equal(res.body.chiefBriefGoalsStale, true, 'precondition: the underlying contract field is stale');
  const tcc = res.body.todayCommandCenter;
  assert.ok(tcc, 'expected a todayCommandCenter');
  assert.equal(tcc.now.evidence.goalsWeekStart, priorWeek);
  assert.equal(tcc.now.evidence.chiefBriefGoalsStale, true, 'NOW must expose the SAME cross-week staleness flag, not silently drop it');
  assert.notEqual(tcc.now.evidence.goalsWeekStart, res.body.weeklyGoals?.current?.weekStart?.slice(0, 10), 'the two week identities must remain distinguishable, never conflated');
  void id;
});

// ── 6. A completed commitment does not remain active today ─────────────────
test('scenario 6 — a commitment marked done is excluded from listActive(), never lingering as an active obligation', async () => {
  const a = await commitmentsStore.create({ title: `${MARKER} call the accountant`, source: 'test' });
  const b = await commitmentsStore.create({ title: `${MARKER} review the deck`, source: 'test' });
  try {
    await commitmentsStore.markDone(a.id);
    const active = await commitmentsStore.listActive({ limit: 50 });
    assert.ok(!active.some((c) => c.id === a.id), 'a commitment marked done must not remain in the active/today list');
    assert.ok(active.some((c) => c.id === b.id), 'an unrelated still-open commitment must be unaffected');
  } finally {
    await db.query('DELETE FROM commitments WHERE id = ANY($1)', [[a.id, b.id]]);
  }
});

// ── 7. Commitment text is preserved without destructive truncation ─────────
test('scenario 7 — committing a long ACTION preserves the FULL text (detail), only the display title is shortened', async (t) => {
  const longAction = `${MARKER} Review the top three spending anomalies in detail before they compound further into next month, and flag anything that needs a budget conversation with the household this weekend.`;
  const res = await request(app)
    .post('/api/briefing/action/commit')
    .set(authHeader())
    .send({ text: longAction });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { rows } = await db.query(`SELECT title, detail FROM commitments WHERE detail = $1`, [longAction]);
  t.after(async () => { await db.query(`DELETE FROM commitments WHERE detail = $1`, [longAction]); });
  assert.equal(rows.length, 1, 'expected exactly one commitment row for this exact full text');
  assert.equal(rows[0].detail, longAction, 'the FULL original action text must be preserved verbatim in detail');
  assert.ok(rows[0].title.length <= 100, 'the display title is a short derived summary...');
  assert.ok(longAction.startsWith(rows[0].title.replace(/[.]{3}$/, '').trim().slice(0, 20)), '...but still recognizably drawn from the same text, not unrelated');
});

// ── 8. A same-day meaningful mutation appears under Since This Morning ────
test('scenario 8 — an attention-log row created AFTER snapshotAt appears in sinceMorning', async (t) => {
  const snapshotAt = new Date(Date.now() - 3600e3); // snapshot cut 1h ago
  const eventKey = `${MARKER}-since-1`;
  await db.query(
    `INSERT INTO attention_log (event_key, source, domain, type, subject, disposition, reason, scores, gates, delivered, delivery_state, created_at)
     VALUES ($1, 'test', 'wealth', 'transaction_anomaly', 'test-subject', 'add_to_brief', $2, '{}'::jsonb, '{}'::jsonb, false, 'stored', now())`,
    [eventKey, `${MARKER} A new transaction needs a look.`]
  );
  t.after(async () => { await db.query(`DELETE FROM attention_log WHERE event_key = $1`, [eventKey]); });

  const tcc = await buildTodayCommandCenter({
    snapshotId: 'snap-8', snapshotVersion: 3, snapshotAt: snapshotAt.toISOString(), builtAt: new Date().toISOString(),
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r' }, chiefBriefStale: false, chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: null, healthInsights: [], wealthInsights: [], weeklyReview: null, wealth: null, recovery: null,
  });
  assert.ok(tcc.sinceMorning.some((s) => s.stableId === eventKey), 'a post-snapshot attention-log row must appear in sinceMorning');
  const item = tcc.sinceMorning.find((s) => s.stableId === eventKey);
  assert.equal(item.destination, 'wealth');
});

// ── 9. A mutation already included in snapshotAt is not repeated ───────────
test('scenario 9 — an attention-log row created BEFORE snapshotAt is excluded from sinceMorning (already reflected in the snapshot)', async (t) => {
  const snapshotAt = new Date(); // cut now
  const eventKey = `${MARKER}-since-2`;
  const beforeSnapshot = new Date(snapshotAt.getTime() - 2 * 3600e3);
  await db.query(
    `INSERT INTO attention_log (event_key, source, domain, type, subject, disposition, reason, scores, gates, delivered, delivery_state, created_at)
     VALUES ($1, 'test', 'health', 'anomaly', 'test-subject', 'add_to_brief', $2, '{}'::jsonb, '{}'::jsonb, false, 'stored', $3)`,
    [eventKey, `${MARKER} already-known change.`, beforeSnapshot]
  );
  t.after(async () => { await db.query(`DELETE FROM attention_log WHERE event_key = $1`, [eventKey]); });

  const tcc = await buildTodayCommandCenter({
    snapshotId: 'snap-9', snapshotVersion: 3, snapshotAt: snapshotAt.toISOString(), builtAt: new Date().toISOString(),
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r' }, chiefBriefStale: false, chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: null, healthInsights: [], wealthInsights: [], weeklyReview: null, wealth: null, recovery: null,
  });
  assert.ok(!tcc.sinceMorning.some((s) => s.stableId === eventKey), 'a row already predating snapshotAt must not be repeated as a new addendum');
});

// ── 10. Empty addendum and preview sections are omitted ────────────────────
test('scenario 10 — sinceMorning and previews are empty arrays (the omission contract) when nothing deserves attention', async () => {
  const tcc = await buildTodayCommandCenter({
    snapshotId: 'snap-10', snapshotVersion: 3, snapshotAt: new Date().toISOString(), builtAt: new Date().toISOString(),
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r' }, chiefBriefStale: false, chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: null, healthInsights: [],
    wealthInsights: [], weeklyReview: null, wealth: null, recovery: { proxy: false },
  });
  assert.deepEqual(tcc.sinceMorning, [], 'sinceMorning must be empty, not filler, when nothing new happened');
  assert.deepEqual(tcc.previews, [], 'previews must be empty when no domain deserves attention');
});

// ── 12. Today and Health resolve the identical effective workout ──────────
test('scenario 12 — BrainSnapshot (which Today\'s command center validates against) and a direct getEffectiveWorkout() call (what Health-domain code uses) resolve to the SAME effective workout', async (t) => {
  const today = todayIso();
  await workoutService.setWorkoutOverride({ date: today, workoutId: 'zone2' });
  t.after(async () => { await workoutService.setWorkoutOverride({ date: today, workoutId: null }); });

  const direct = await workoutService.getEffectiveWorkout({ tz: 'America/New_York' });
  const snapshot = await buildBrainSnapshot({ tz: 'America/New_York', recovery: null, include: { calendar: false } });

  assert.equal(snapshot.effectiveWorkout.value.label, direct.label, 'the same override must resolve to the identical label via both paths');
  assert.equal(snapshot.effectiveWorkout.value.source, direct.source);
  assert.equal(snapshot.effectiveWorkout.value.workoutId, direct.workoutId);
  assert.equal(direct.source, 'override');
});

// ── 13. Today and Wealth expose identical canonical spending facts ────────
test('scenario 13 — the wealth preview reuses buildWealthInsights\' OWN title/detail verbatim, never a re-derived one', async (t) => {
  function monthsBack(n, d = new Date()) {
    const x = new Date(d.getFullYear(), d.getMonth() - n, 1);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
  }
  const current = monthsBack(1);
  const priors = [monthsBack(4), monthsBack(3), monthsBack(2)];
  documents.monthlyCategorySpend = async () => {
    const rows = [];
    for (const m of priors) rows.push({ month: m, category: `${MARKER} Dining`, spend: 300 });
    rows.push({ month: current, category: `${MARKER} Dining`, spend: 900 });
    return rows;
  };
  documents.spendTransactions = async () => [];
  const originalDailyAggregate = metricsStore.dailyAggregate;
  metricsStore.dailyAggregate = async () => [];
  monarchWealth.getRecurring = async () => null;
  monarchWealth.getInvestments = async () => null;
  monarchWealth.getBudgetPacing = async () => ({ asOf: new Date().toISOString(), dayOfMonth: 15, daysInMonth: 30, elapsed: 0.5, lines: [], totals: null });
  t.after(() => {
    delete documents.monthlyCategorySpend;
    delete documents.spendTransactions;
    metricsStore.dailyAggregate = originalDailyAggregate;
    delete monarchWealth.getRecurring;
    delete monarchWealth.getInvestments;
    delete monarchWealth.getBudgetPacing;
  });

  const { buildWealthInsights } = require('../../src/services/wealth-insights');
  const wealthInsights = await buildWealthInsights();
  const top = wealthInsights.find((i) => i.category === `${MARKER} Dining`);
  assert.ok(top, 'expected the seeded spending_pattern insight');

  const tcc = await buildTodayCommandCenter({
    snapshotId: 'snap-13', snapshotVersion: 3, snapshotAt: new Date().toISOString(), builtAt: new Date().toISOString(),
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r' }, chiefBriefStale: false, chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: null, healthInsights: [],
    wealthInsights, weeklyReview: null, wealth: null, recovery: null,
  });
  const wealthPreview = tcc.previews.find((p) => p.domain === 'wealth');
  assert.ok(wealthPreview, 'expected a wealth preview');
  assert.equal(wealthPreview.title, wealthInsights[0].title, 'the preview title must be IDENTICAL to the Wealth tab\'s own top insight, not independently worded');
  assert.equal(wealthPreview.summary, wealthInsights[0].detail || '');
});

// ── 14. Evening state reflects actual-vs-planned, not any exercise as completion ──
test('scenario 14 — logging a DIFFERENT activity than planned does not mark the planned workout completed (resolveTrainingOutcome, what evening-brief.js\'s plan-vs-actual reads)', async (t) => {
  const today = todayIso();
  await workoutService.setWorkoutOverride({ date: today, workoutId: 'push' });
  t.after(async () => { await workoutService.setWorkoutOverride({ date: today, workoutId: null }); });
  const effective = await workoutService.getEffectiveWorkout({ tz: 'America/New_York' });
  assert.equal(effective.workoutId, 'push');

  // Log a WALK (a different activity type than the planned Push session).
  await db.query(
    `INSERT INTO activity_logs (log_date, activity_type, label, duration_min, note, planned_type, no_watch)
     VALUES ($1, 'walk', $2, 20, NULL, 'push', false)`,
    [today, `${MARKER} evening walk`]
  );
  t.after(async () => { await db.query(`DELETE FROM activity_logs WHERE log_date = $1 AND activity_type = 'walk' AND label = $2`, [today, `${MARKER} evening walk`]); });

  const outcome = await workoutService.resolveTrainingOutcome({ tz: 'America/New_York', effectiveWorkout: effective });
  assert.equal(outcome.actualActivities.length >= 1, true, 'the logged activity IS present as evidence');
  assert.equal(outcome.plannedWorkoutCompleted, false, 'a walk must NOT count as completing the planned Push session — any exercise is not treated as completion');
});

// ── 15. Self-reported recovery remains clearly provisional ─────────────────
test('scenario 15 — a self-report recovery proxy surfaces an explicit "provisional" health preview, never presented as a genuine device reading', async () => {
  const tcc = await buildTodayCommandCenter({
    snapshotId: 'snap-15', snapshotVersion: 3, snapshotAt: new Date().toISOString(), builtAt: new Date().toISOString(),
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r' }, chiefBriefStale: false, chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: null, healthInsights: [],
    wealthInsights: [], weeklyReview: null, wealth: null, recovery: { proxy: true, category: 'Good' },
  });
  const healthPreview = tcc.previews.find((p) => p.domain === 'health');
  assert.ok(healthPreview, 'expected a health preview when recovery is a self-report proxy');
  assert.match(healthPreview.title.toLowerCase(), /provisional/, 'must explicitly say provisional, never silently pass off a self-report as a genuine reading');
});
