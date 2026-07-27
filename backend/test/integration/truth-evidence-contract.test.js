// NormOS audit priority #1 — universal truth-and-evidence contract. The 12
// required regression scenarios for the 10 confirmed product failures (VO2
// disagreement, conflated week identity, false sleep precision, blended HRV
// sources, overclaimed correlations, noise-triggered wellbeing warnings,
// blurred wealth windows, repeat-flagged intentional spending, conflated
// build/sync timestamps, unsupported causal language). Each scenario exercises
// the REAL production function or route (no source-string assertions, no
// logic-bypassing mocks) against real Postgres.
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
const intentionsStore = require('../../src/store/intentions');
const commitmentsStore = require('../../src/store/commitments');
const goalsStore = require('../../src/store/goals');
const sourcesStore = require('../../src/store/sources');
const dismissedInsights = require('../../src/store/dismissedInsights');
const { buildWealthInsights } = require('../../src/services/wealth-insights');
const { SNAPSHOT_VERSION } = require('../../src/brain/snapshot');
const { canonicalFactsFrom } = require('../../src/brain/snapshot');
const { buildEvidenceClaims } = require('../../src/brain/evidenceClaim');
const claimValidator = require('../../src/brain/claimValidator');
const { computeAnomalies } = require('../../src/intelligence/analyze');
const { computeHealthComposites, selfReportRecovery, RECOVERY_SOURCE_LOCK } = require('../../src/intelligence/recovery');
const { runTool } = require('../../src/chat/realtimeTools');

const app = buildTestApp();
const MARKER = `truth-${Date.now()}`;
const TEST_RUN_STARTED_AT = new Date();

function todayIso() {
  // LOCAL (America/New_York) calendar date, not UTC — see the identical
  // comment in today-command-center.test.js's todayIso().
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Minimal cache-eligible `briefings` row: recent generated_at (today, local),
 *  snapshotVersion current, plus whatever `content` overrides the scenario needs. */
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

const seededBriefingIds = [];
const seededMetricDomainsMetrics = new Set();

after(async () => {
  if (seededBriefingIds.length) {
    await db.query(`DELETE FROM briefings WHERE id = ANY($1)`, [seededBriefingIds]).catch(() => {});
  }
  await db.query(`DELETE FROM briefings WHERE content->>'day' = $1 AND content->'chiefBrief'->>'synthesis' LIKE $2`, [todayIso(), `${MARKER}%`]).catch(() => {});
  // A `?refresh=1` full build (scenarios 7/9) persists its OWN new `briefings`
  // row via the real route, regardless of whether the mocked chiefBrief text
  // cleared the quality bar — catch every 'daily' row this file's run could
  // have created, not just ones matching the marker text, or a stray row
  // survives into whichever integration test file runs next and breaks its
  // "no today briefing exists yet" assumptions.
  await db.query(`DELETE FROM briefings WHERE kind = 'daily' AND generated_at >= $1`, [TEST_RUN_STARTED_AT]).catch(() => {});
  for (const [domain, metric] of seededMetricDomainsMetrics) {
    await db.query(`DELETE FROM metrics WHERE domain = $1 AND metric = $2 AND source LIKE $3`, [domain, metric, `${MARKER}%`]).catch(() => {});
  }
  await db.query(`DELETE FROM weekly_intentions WHERE context LIKE $1`, [`${MARKER}%`]).catch(() => {});
  await db.query(`DELETE FROM dismissed_insights WHERE title LIKE $1`, [`%${MARKER}%`]).catch(() => {});
  await closeDb();
});

async function seedMetric(domain, metric, source, points) {
  seededMetricDomainsMetrics.add([domain, metric]);
  // metrics.source has a FK into the sources table — a marker-suffixed test
  // source id must be registered before it can be written.
  await sourcesStore.registerSource({ id: source, domain, displayName: source });
  await metricsStore.insertMetrics(
    points.map((p) => ({ domain, metric, source, ts: p.ts, value: p.value }))
  );
}

// ── Scenario 1: VO2 max identical across "What The Data Shows" title and its
// own evidence.current, even when served from a cache-hit whose title/detail
// were baked in hours earlier by analyze() (the exact "46.3 vs 46.6" bug). ──
test('scenario 1 — VO2 title and evidence.current agree on a fresh cache-hit serve, never two different numbers', async (t) => {
  await seedMetric('health', 'vo2_max', `${MARKER}-apple_health`, [{ ts: new Date(), value: 46.6 }]);
  t.after(async () => {
    await db.query(`DELETE FROM metrics WHERE domain='health' AND metric='vo2_max' AND source = $1`, [`${MARKER}-apple_health`]);
  });
  const id = await seedCachedBriefing({
    healthInsights: [{
      type: 'fitness', title: 'VO₂ max 46.3', detail: 'stale detail',
      confidence: 0.8,
      evidence: { auto: true, kind: 'fitness', metric: 'health:vo2_max', current: 46.3, per90: null, n: 10, asOf: new Date(Date.now() - 6 * 3600e3).toISOString() },
    }],
  });
  seededBriefingIds.push(id);

  const res = await request(app).get('/api/briefing').set(authHeader()).timeout(15000);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const fitness = (res.body.healthInsights || []).find((f) => f.type === 'fitness');
  assert.ok(fitness, 'expected a fitness insight in the response');
  assert.equal(fitness.evidence.current, 46.6, 'evidence.current must be freshened, not left at the stale cached value');
  assert.match(fitness.title, /46\.6/, 'title must be freshened to the SAME number as evidence.current');
  assert.doesNotMatch(fitness.title, /46\.3/, 'the stale title must not survive alongside a fresh evidence.current');
});

// ── Scenario 2: prior-week vs current-week goals carry distinct period IDs. ──
// Updated for the Today command-center cleanup (Part 2 — automatic
// stale-period repair): a cross-week goal mismatch is no longer just
// flagged and served as-is — briefing.js's cache-hit path now
// automatically repairs it (one scoped chief-brief rebuild) before this
// response goes out. The underlying period-identity fields this scenario
// exists to prove (weeklyGoals refreshed live, the two periods never
// conflated) still apply, just against the REPAIRED state.
test('scenario 2 — a cached chiefBrief built against last week\'s goals is automatically repaired against this week\'s live (different) goals, never served stale', async (t) => {
  const priorWeek = intentionsStore.priorWeekStart ? intentionsStore.priorWeekStart() : null;
  const currentWeek = intentionsStore.weekStart();
  await intentionsStore.saveIntention({ weekStart: currentWeek, context: `${MARKER} current week`, goals: [{ text: `${MARKER} ship the thing`, achieved: false }] });
  t.after(async () => {
    await db.query(`DELETE FROM weekly_intentions WHERE week_start = $1`, [currentWeek]);
  });

  const id = await seedCachedBriefing({
    chiefBrief: { synthesis: `${MARKER} all this week's goals are done — great follow-through.`, action: 'a', risk: 'r', move: 'm', openQuestion: '' },
    goalsWeekStart: priorWeek,
  });
  seededBriefingIds.push(id);

  llm.generateText = async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) {
      return {
        text: JSON.stringify({
          chiefBrief: {
            synthesis: `${MARKER} repaired — this week's goal is still open, ship the thing is on deck today.`,
            action: 'Make progress on the open goal today.',
            risk: 'No material risk is flagged for today at all.',
            move: 'No change is needed from the current plan.',
            openQuestion: '',
          },
          morningFocus: 'Keep today steady, protect the open goal, and revisit the full plan again once more data lands in later.',
        }),
        stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
      };
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
  t.after(() => { delete llm.generateText; });

  const res = await request(app).get('/api/briefing').set(authHeader()).timeout(20000);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.chiefBrief?.synthesis || '', /repaired/, 'the served synthesis must be the FRESH repair attempt, never the old stale cached claim');
  const liveWeekStart = String(res.body.weeklyGoals?.current?.weekStart ?? '').slice(0, 10);
  assert.equal(liveWeekStart, currentWeek, 'weeklyGoals is refreshed LIVE even on a cache-hit serve');
  assert.equal(String(res.body.goalsWeekStart).slice(0, 10), currentWeek, 'the repaired chiefBrief\'s own period identity must now match the live current week');
  assert.equal(res.body.chiefBriefGoalsStale, false, 'once repaired, the cross-week mismatch must no longer be flagged — it is resolved, not just noted');
});

// ── Scenario 3: self-reported sleep can't generate unsupported precise
// sub-scores or minute-level debt. ──
test('scenario 3 — a self-report recovery proxy carries a category, never manufactured quality/duration sub-scores', () => {
  const proxy = selfReportRecovery({ quality: 4, hours: 8, need: 8 });
  assert.ok(proxy && typeof proxy.score === 'number');
  assert.ok(['Good', 'Fair', 'Poor'].includes(proxy.category), 'a categorical read, not fabricated percentile sub-scores');
  assert.equal(proxy.parts, undefined, 'no parts.quality/parts.duration — those were never real 30-day percentiles for a 1-5 self-report');
});

test('scenario 3b — a week containing a self-reported (approximate) night rounds sleep debt to the quarter-hour and marks it approximate', async (t) => {
  const days = [];
  const now = Date.now();
  for (let i = 6; i >= 1; i--) days.push({ ts: new Date(now - i * 864e5), value: 7.6, source: 'eight_sleep' }); // measured nights, consistent shortfall
  days.push({ ts: new Date(now), value: 8, source: 'self_report' }); // last night: a self-report, approximate
  await metricsStore.insertMetrics(days.map((d) => ({ domain: 'health', metric: 'sleep_hours', source: d.source, ts: d.ts, value: d.value })));
  await metricsStore.insertMetrics(days.map((d) => ({ domain: 'health', metric: 'sleep_need', source: 'eight_sleep', ts: d.ts, value: 8.25 })));
  t.after(async () => {
    await db.query(`DELETE FROM metrics WHERE domain='health' AND metric IN ('sleep_hours','sleep_need') AND ts >= $1`, [new Date(now - 7 * 864e5)]);
  });

  const from = new Date(now - 7 * 864e5);
  const [sleepRows, needRows] = await Promise.all([
    metricsStore.dailyAggregate({ domain: 'health', metric: 'sleep_hours', from, agg: 'avg' }),
    metricsStore.dailyAggregate({ domain: 'health', metric: 'sleep_need', from, agg: 'avg' }),
  ]);
  const composites = computeHealthComposites(
    { 'health:sleep_hours': sleepRows, 'health:sleep_need': needRows },
    { selfReportedSleepNights: 1 }
  );
  const debtFinding = composites.find((c) => c.type === 'sleep_debt');
  assert.ok(debtFinding, 'expected a sleep_debt finding from a consistent 7-night shortfall');
  assert.equal(debtFinding.evidence.approximate, true, 'must be marked approximate when a self-report night is in the window');
  const debtHours = debtFinding.evidence.debtHours ?? debtFinding.evidence.surplusHours;
  assert.equal(Math.round(debtHours * 4) / 4, debtHours, 'debt/surplus must be rounded to the nearest 15 minutes, never minute-level precision, from an approximate input');
  assert.ok(debtFinding.confidence <= 0.6, 'lower confidence than a fully device-measured week');
});

// ── Scenario 4: daytime Apple Watch HRV and overnight Eight Sleep HRV stay
// source-distinct — a voice/chat query never silently answers with the
// wrong-source reading. ──
test('scenario 4 — query_metric answers HRV from the overnight source lock, never a same-day daytime Apple Watch reading', async (t) => {
  const today = new Date();
  await metricsStore.insertMetrics([
    { domain: 'health', metric: 'hrv', source: 'apple_health', ts: new Date(today.getTime() - 3 * 3600e3), value: 95 }, // daytime, much higher
    { domain: 'health', metric: 'hrv', source: 'eight_sleep', ts: new Date(today.getTime() - 8 * 3600e3), value: 52 }, // overnight
  ]);
  t.after(async () => {
    await db.query(`DELETE FROM metrics WHERE domain='health' AND metric='hrv' AND ts >= $1`, [new Date(today.getTime() - 24 * 3600e3)]);
  });

  assert.deepEqual(RECOVERY_SOURCE_LOCK['health:hrv'].sort(), ['eight_sleep', 'eight_sleep_baseline'].sort());
  const result = await runTool('query_metric', { domain: 'health', metric: 'hrv', days: 3 });
  assert.ok(result.latest, 'expected a latest reading');
  assert.equal(result.latest.value, 52, 'must answer from the overnight eight_sleep reading, not the daytime Apple Watch one');
  assert.equal(result.latest.source, 'eight_sleep');
  assert.notEqual(result.latest.source, 'apple_health', 'daytime and overnight HRV must stay source-distinct, never silently blended');
});

// ── Scenario 5: an association is never labeled "confirmed"/"proven" —
// exercised through the SAME validateChiefBriefClaims Chief Brief's real
// build now calls with facts.claims wired in (previously the gap: Chief
// Brief's chiefFacts never carried .claims at all). ──
test('scenario 5 — a supported-association recovery driver overclaimed as "confirmed" is caught by the real chief-brief validator', () => {
  const facts = canonicalFactsFrom({ recoveryDrivers: [`${MARKER} drank wine last night`] });
  facts.claims = buildEvidenceClaims(facts);
  const association = facts.claims.find((c) => c.claimType === 'association');
  assert.ok(association, 'the driver produced an ASSOCIATION-tier claim');
  assert.notEqual(association.evidenceTier, 'established', 'a personal driver association is never established-tier');

  const sentence = `It's now confirmed that ${MARKER} drank wine last night is driving every dip in your recovery.`;
  const result = claimValidator.validateChiefBriefClaims(
    { chiefBrief: { synthesis: sentence, action: 'a', risk: 'r', move: 'm' } },
    facts
  );
  assert.ok(
    result.violations.some((v) => v.check === 'association_overclaim' || v.check === 'causal_language_overclaim'),
    'the real chief-brief validator (as wired into routes/briefing.js) must catch this'
  );
});

// ── Scenario 6: a 4/5 focus score does not trigger a warning solely because
// it sits below a tight personal baseline of 4.83. ──
test('scenario 6 — a healthy-absolute-level focus score never gets a "worth attention" anomaly from a high personal baseline alone', async (t) => {
  const now = Date.now();
  const rows = [];
  // 29 days of alternating 5/4 (mean ≈ 4.83, real day-to-day spread), then
  // today = 4 — a relative dip against ONLY this user's own tight baseline,
  // but an absolutely healthy score (cat.wellbeingLevel(4) === 'high').
  for (let i = 29; i >= 1; i--) rows.push({ ts: new Date(now - i * 864e5), value: i % 3 === 0 ? 4 : 5 });
  rows.push({ ts: new Date(now), value: 4 });
  await sourcesStore.registerSource({ id: `${MARKER}-checkin`, domain: 'wellbeing', displayName: 'test checkin' });
  await metricsStore.insertMetrics(rows.map((r) => ({ domain: 'wellbeing', metric: 'focus', source: `${MARKER}-checkin`, ts: r.ts, value: r.value })));
  t.after(async () => {
    await db.query(`DELETE FROM metrics WHERE domain='wellbeing' AND metric='focus' AND source = $1`, [`${MARKER}-checkin`]);
  });

  const from = new Date(now - 30 * 864e5);
  const series = await metricsStore.dailyAggregate({ domain: 'wellbeing', metric: 'focus', from, agg: 'avg' });
  assert.ok(series.length >= 9, 'need enough seeded days for the anomaly baseline to evaluate');
  const findings = computeAnomalies({ 'wellbeing:focus': series });
  const focusWarning = findings.find((f) => f.domains?.includes('wellbeing') && /focus/i.test(f.title) && /worth attention/i.test(f.title));
  assert.equal(focusWarning, undefined, 'a healthy absolute score (4/5) must never read as "worth attention" from relative dip alone');
});

// ── Scenario 7: MTD and rolling-30-day spending retain explicit, distinct
// windows on the SAME wealth response. ──
test('scenario 7 — calendar month-to-date spend and the rolling-30-day figure are both present, separately windowed, never blurred into one number', async (t) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  // Spend BEFORE this calendar month started but still inside the rolling
  // 30-day window (if the test runs early in the month) — makes MTD and
  // rolling-30d genuinely different sums whenever there IS such a day.
  const priorMonthDay = new Date(monthStart.getTime() - 3 * 864e5);
  await sourcesStore.registerSource({ id: `${MARKER}-mtd`, domain: 'wealth', displayName: 'test mtd' });
  await metricsStore.insertMetrics([
    { domain: 'wealth', metric: 'spending_discretionary', source: `${MARKER}-mtd`, ts: new Date(monthStart.getTime() + 864e3), value: 200 },
    { domain: 'wealth', metric: 'spending_discretionary', source: `${MARKER}-mtd`, ts: priorMonthDay, value: 150 },
    { domain: 'wealth', metric: 'net_worth', source: `${MARKER}-mtd`, ts: now, value: 500000 },
  ]);
  t.after(async () => {
    await db.query(`DELETE FROM metrics WHERE source = $1`, [`${MARKER}-mtd`]);
  });
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
        text: JSON.stringify({ chiefBrief: { synthesis: `${MARKER} windows check — spending and net worth figures are being reviewed across their own separate, clearly labeled time windows today.`, action: 'Review the spending windows before assuming any single figure tells the whole story.', risk: 'None flagged beyond the usual month-to-date drift.', move: 'Take one more look at the wealth tab this evening.', openQuestion: '' }, morningFocus: 'Review the week ahead calmly and steadily.' }),
        stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
      };
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
  t.after(() => { delete llm.generateText; });

  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.wealth, 'expected a wealth object in the response');
  assert.ok('spendingMtd' in res.body.wealth, 'a genuine calendar-MTD figure must be exposed');
  assert.ok('discretionaryThisMonth' in res.body.wealth, 'the rolling-30-day figure must ALSO be exposed, distinctly');
  assert.ok(res.body.wealth.mtdSince, 'the MTD window\'s own start date must be exposed so the client never has to guess the boundary');
  // The two are computed over genuinely different windows (calendar-month-
  // start vs now−30d) — with spend seeded 3 days before this month started,
  // they must disagree, proving neither silently stands in for the other.
  assert.notEqual(res.body.wealth.spendingMtd, res.body.wealth.discretionaryThisMonth, 'MTD and rolling-30d must retain their own distinct sums, not collapse to one shared number');
});

// ── Scenario 8: explained/intentional spending isn't repeatedly surfaced as
// an unexplained anomaly once dismissed. ──
test('scenario 8 — a dismissed spending insight stays suppressed across a fresh buildWealthInsights() run, real Postgres round-trip', async (t) => {
  function monthsBack(n, d = new Date()) {
    const x = new Date(d.getFullYear(), d.getMonth() - n, 1);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
  }
  const current = monthsBack(1);
  const priors = [monthsBack(4), monthsBack(3), monthsBack(2)];
  documents.monthlyCategorySpend = async () => {
    const rows = [];
    for (const m of priors) rows.push({ month: m, category: `${MARKER} Travel`, spend: 200 });
    rows.push({ month: current, category: `${MARKER} Travel`, spend: 900 }); // a large, but intentional/explained, trip
    return rows;
  };
  documents.spendTransactions = async () => [];
  // Save/restore (not delete) — dailyAggregate is a real named export other
  // tests in THIS file rely on; deleting the property leaves it permanently
  // undefined for every test that runs afterward in the same process.
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

  const first = await buildWealthInsights();
  const target = first.find((i) => i.type === 'spending_pattern' && i.category === `${MARKER} Travel`);
  assert.ok(target, 'expected a spending_pattern card for the seeded category');
  const key = dismissedInsights.dismissKey(target);
  await dismissedInsights.dismiss(key, target.title);
  t.after(async () => { await dismissedInsights.undismiss(key); });

  const second = await buildWealthInsights();
  const dismissedSet = await dismissedInsights.dismissedKeys();
  const filtered = dismissedInsights.applyDismissals(second, dismissedSet);
  assert.ok(!filtered.some((i) => i.type === 'spending_pattern' && i.category === `${MARKER} Travel`), 'a dismissed, explained spending insight must not resurface as an unexplained anomaly on the very next build');
});

// ── Scenario 9: "brief built at" and per-source "synced at" stay distinct
// facts, never conflated into one timestamp. ──
test('scenario 9 — wealth.sourceSyncedAt (Monarch\'s real sync clock), wealth.syncedAt (the net-worth reading\'s own data date), and the response\'s builtAt are three independently meaningful timestamps', async (t) => {
  await sourcesStore.registerSource({ id: 'monarch', domain: 'wealth', displayName: 'Monarch' });
  const knownSyncAt = new Date(Date.now() - 2 * 3600e3); // 2h ago — distinct from the metric ts and from "now"
  await db.query(`UPDATE sources SET last_sync_at = $1, status = 'active' WHERE id = 'monarch'`, [knownSyncAt]);
  const metricTs = new Date(Date.now() - 26 * 3600e3); // a full day+ before the sync clock — a different fact
  await sourcesStore.registerSource({ id: `${MARKER}-sync`, domain: 'wealth', displayName: 'test sync' });
  await metricsStore.insertMetrics([{ domain: 'wealth', metric: 'net_worth', source: `${MARKER}-sync`, ts: metricTs, value: 400000 }]);
  t.after(async () => {
    await db.query(`DELETE FROM metrics WHERE source = $1`, [`${MARKER}-sync`]);
  });
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
        text: JSON.stringify({ chiefBrief: { synthesis: `${MARKER} sync check — the wealth figures reflect a real Monarch sync from earlier, distinct from when this brief itself was built just now.`, action: 'Confirm the sync timestamp before treating today\'s numbers as brand new.', risk: 'None flagged beyond the usual sync lag.', move: 'Check back later if a fresher sync matters today.', openQuestion: '' }, morningFocus: 'Take today one step at a time and stay grounded.' }),
        stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8',
      };
    }
    return JSON.stringify({ quoteInsight: '', notionQuote: '', notionInsight: '' });
  };
  t.after(() => { delete llm.generateText; });

  const res = await request(app).get('/api/briefing').query({ refresh: '1' }).set(authHeader()).timeout(20000);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.wealth?.sourceSyncedAt, 'expected the real Monarch sync-clock timestamp');
  assert.ok(res.body.wealth?.syncedAt, 'expected the net-worth reading\'s own as-of date');
  assert.ok(res.body.builtAt, 'expected the response\'s own build timestamp');
  const t1 = new Date(res.body.wealth.sourceSyncedAt).getTime();
  const t2 = new Date(res.body.wealth.syncedAt).getTime();
  const t3 = new Date(res.body.builtAt).getTime();
  assert.notEqual(t1, t2, 'source-synced-at and the metric\'s own as-of date must not be conflated');
  assert.notEqual(t1, t3, 'source-synced-at and the response\'s build time must not be conflated');
  assert.notEqual(t2, t3, 'the metric\'s as-of date and the response\'s build time must not be conflated');
});

// ── Scenario 10: causal language is rejected unless backed by established
// evidence or a matching CONFIRMED experiment. ──
test('scenario 10 — causal ("worsens"/"drives") language on a weak association is rejected without a matching confirmed experiment, and passes once one exists', () => {
  const facts = {
    claims: [{ claimType: 'association', evidenceTier: 'supported_association', allowedLanguage: 'hedged', subject: `${MARKER}`, value: 'late meals and HRV' }],
    experiments: [],
  };
  const rejected = claimValidator.checkCausalLanguage(
    [['synthesis', 'Late meals seem to worsen your HRV overnight, worth watching.']],
    facts
  );
  assert.ok(rejected.length >= 1, 'unhedged causal language on a weak claim with no confirmed experiment must be rejected');
  assert.equal(rejected[0].check, 'causal_language_overclaim');

  const withConfirmedExperiment = {
    claims: [{ claimType: 'association', evidenceTier: 'supported_association', allowedLanguage: 'hedged', subject: `${MARKER}`, value: 'magnesium and sleep' }],
    experiments: [{ hypothesis: 'Magnesium before bed improves sleep duration', lever: 'habits:magnesium', metric: 'health:sleep', verdict: 'confirmed' }],
  };
  const authorized = claimValidator.checkCausalLanguage(
    [['synthesis', 'Magnesium clearly improves your sleep quality most nights.']],
    withConfirmedExperiment
  );
  assert.deepEqual(authorized, [], 'the SAME causal wording is allowed once a matching confirmed experiment backs that exact intervention+outcome');
});

// ── Scenario 11: the same canonical facts produce identical claims for every
// registered fact, regardless of which surface consumes them. ──
test('scenario 11 — one BrainSnapshot-shaped facts object produces byte-identical EvidenceClaims across two independent consumption points', async (t) => {
  const goalRow = await goalsStore.createGoal({ title: `${MARKER} ship the deck` });
  const commitmentRow = await commitmentsStore.create({ title: `${MARKER} call the accountant`, source: 'test' });
  t.after(async () => {
    await goalsStore.deleteGoal(goalRow.id).catch(() => {});
    await db.query('DELETE FROM commitments WHERE id = $1', [commitmentRow.id]).catch(() => {});
  });
  const goals = await goalsStore.listGoals({ status: 'active' });
  const commitments = await commitmentsStore.listActive({ limit: 20 });

  const facts = canonicalFactsFrom({
    recovery: { band: 'yellow', score: 62 },
    goals, commitments,
    wealth: { spendingMtd: 1234 },
    forecast: { capacity: { grade: 'B', band: 'yellow' }, tomorrow: { band: 'green' } },
    localDate: '2026-07-20',
  });

  // "Health surface" consumption.
  const claimsA = buildEvidenceClaims(facts, { snapshotId: 'snap-1', snapshotVersion: 3 });
  // "Ask surface" consumption — the SAME facts object, a second independent call.
  const claimsB = buildEvidenceClaims(facts, { snapshotId: 'snap-1', snapshotVersion: 3 });

  assert.equal(claimsA.length, claimsB.length, 'both consumers derive the same NUMBER of claims from one facts object');
  const strip = (c) => ({ ...c, claimId: undefined });
  assert.deepEqual(claimsA.map(strip), claimsB.map(strip), 'every claim (value/tier/language/refs) must be byte-identical across surfaces — one derivation, not two');

  const bandClaim = claimsA.find((c) => c.subject === 'recovery' && c.predicate === 'band');
  assert.equal(bandClaim.value, facts.recoveryBand, 'the claim value traces back to the SAME canonical fact, never re-derived');
  const goalClaim = claimsA.find((c) => c.subject === `goal:${MARKER} ship the deck`);
  assert.ok(goalClaim, 'the real DB-backed goal produced its own claim');
  assert.equal(goalClaim.value, false);
  const commitmentClaim = claimsA.find((c) => c.subject === `commitment:${MARKER} call the accountant`);
  assert.ok(commitmentClaim, 'the real DB-backed commitment produced its own claim');
  const spendClaim = claimsA.find((c) => c.subject === 'wealth' && c.predicate === 'spendingMonthToDate');
  assert.equal(spendClaim.value, 1234);
});

// ── Scenario 12: missing/stale sources downgrade confidence/precision. ──
test('scenario 12 — a self-report recovery proxy carries lower confidence than a device reading, and a stale Monarch sync is visibly flagged', async (t) => {
  const deviceFacts = canonicalFactsFrom({ recovery: { band: 'green', score: 88, proxy: false } });
  const proxyFacts = canonicalFactsFrom({ recovery: { band: 'green', score: 88, proxy: true } });
  const deviceClaim = buildEvidenceClaims(deviceFacts).find((c) => c.subject === 'recovery' && c.predicate === 'band');
  const proxyClaim = buildEvidenceClaims(proxyFacts).find((c) => c.subject === 'recovery' && c.predicate === 'band');
  assert.ok(proxyClaim.confidence < deviceClaim.confidence, 'a self-report/missing-device proxy must carry lower confidence than a real overnight reading, even reporting the identical band');

  await sourcesStore.registerSource({ id: `${MARKER}-monarch`, domain: 'wealth', displayName: 'Monarch (test)' });
  const staleAt = new Date(Date.now() - 5 * 24 * 3600e3); // 5 days stale
  await db.query(`UPDATE sources SET last_sync_at = $1, status = 'active' WHERE id = $2`, [staleAt, `${MARKER}-monarch`]);
  t.after(async () => { await db.query(`DELETE FROM sources WHERE id = $1`, [`${MARKER}-monarch`]); });
  const src = await sourcesStore.getSource(`${MARKER}-monarch`);
  const ageDays = (Date.now() - new Date(src.last_sync_at).getTime()) / 864e5;
  assert.ok(ageDays >= 4.9, 'the seeded source is genuinely stale');
  // This is the same real ground truth routes/briefing.js's alerts block and
  // wealth.sourceSyncedAt both read — a stale source is visible as data, not
  // silently presented as if it were current.
  assert.ok(src.last_sync_at, 'a stale source still carries its real last-sync fact rather than being silently blank');
});
