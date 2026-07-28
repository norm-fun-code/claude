// "Since This Morning" internal-diagnostic leak fix. Production bug: Today
// showed "value 0.875 is real but below the interrupt/offer bar — deferred
// to the next briefing" — the Attention Policy's INTERNAL decision-audit
// string (intelligence/attention.js's judge(), attention_log.reason),
// rendered verbatim as a user-facing card (brain/todayCommandCenter.js's old
// buildSinceMorning: `summary: r.reason || ...`).
//
// The fix is a data-contract change, not string sanitization: attention_log
// now persists each event's own already-approved-for-display title/body
// (store/attention.js's insertRow -> approvedUserFacing, migration 066) as
// user_title/user_detail, and a NEW, narrowly-scoped query
// (sinceMorningForUser) feeds Today's card ONLY from those columns — never
// falling back to `reason` — excluding any row that lacks them entirely.
// pendingForBrief() (the chief-brief LLM prompt's context builder) is left
// completely untouched.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const attentionStore = require('../../src/store/attention');
const { fromWealthCandidate } = require('../../src/intelligence/events');
const { eventKey } = require('../../src/intelligence/attention');
const { buildTodayCommandCenter } = require('../../src/brain/todayCommandCenter');

const MARKER = `attn-uf-${Date.now()}`;

after(async () => {
  await db.query(`DELETE FROM attention_log WHERE event_key LIKE $1`, [`%${MARKER}%`]);
  await closeDb();
});

function baseTccInput(snapshotAt) {
  return {
    snapshotId: 'snap', snapshotVersion: 3, snapshotAt: snapshotAt.toISOString(), builtAt: new Date().toISOString(),
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r' }, chiefBriefStale: false, chiefBriefPending: false, chiefBriefQuality: { status: 'fresh' },
    forecasts: [], todayForecast: null, healthInsights: [], wealthInsights: [], weeklyReview: null, wealth: null, recovery: null,
  };
}

// ── required 3: a post-snapshot row whose only text is the internal reason is never surfaced ──
test('required 3: an add_to_brief row with a reason but no approved user_title/user_detail is excluded from sinceMorningForUser and from Today\'s payload', async () => {
  const snapshotAt = new Date(Date.now() - 3600e3);
  const key = `${MARKER}-reason-only`;
  const internalReason = 'value 0.875 is real but below the interrupt/offer bar — deferred to the next briefing';
  await db.query(
    `INSERT INTO attention_log (event_key, source, domain, type, subject, disposition, reason, scores, gates, delivered, delivery_state, created_at)
     VALUES ($1, 'test', 'habits', 'trend', 'test-subject', 'add_to_brief', $2, '{"value":0.875}'::jsonb, '{"brief_default":true}'::jsonb, false, 'stored', now())`,
    [key, internalReason]
  );

  const rows = await attentionStore.sinceMorningForUser({ since: snapshotAt });
  assert.ok(!rows.some((r) => r.event_key === key), 'a reason-only row must be excluded at the store layer');

  const tcc = await buildTodayCommandCenter(baseTccInput(snapshotAt));
  assert.ok(!tcc.sinceMorning.some((s) => s.stableId === key), 'a reason-only row must be excluded from the Today payload');
  const serialized = JSON.stringify(tcc);
  assert.ok(!serialized.includes('interrupt/offer bar'), 'internal threshold language must never reach the Today payload');
  assert.ok(!serialized.includes('deferred to the next briefing'), 'internal disposition language must never reach the Today payload');
});

// ── required 4: a qualifying post-snapshot event WITH approved content is surfaced correctly ──
test('required 4: an add_to_brief row with both user_title and user_detail is surfaced with that exact copy', async () => {
  const snapshotAt = new Date(Date.now() - 3600e3);
  const key = `${MARKER}-qualifies`;
  await db.query(
    `INSERT INTO attention_log (event_key, source, domain, type, subject, disposition, reason, scores, gates, delivered, delivery_state, created_at, user_title, user_detail)
     VALUES ($1, 'test', 'health', 'trend', 'test-subject', 'add_to_brief', 'value 0.61 cleared the brief bar', '{"value":0.61}'::jsonb, '{}'::jsonb, false, 'stored', now(), $2, $3)`,
    [key, `${MARKER} Your resting HR trended down this week`, `${MARKER} Averaging 3bpm lower than last week — consistent with the extra sleep.`]
  );

  const rows = await attentionStore.sinceMorningForUser({ since: snapshotAt });
  const row = rows.find((r) => r.event_key === key);
  assert.ok(row, 'a fully-qualified row must be returned');
  assert.equal(row.user_title, `${MARKER} Your resting HR trended down this week`);
  assert.equal(row.user_detail, `${MARKER} Averaging 3bpm lower than last week — consistent with the extra sleep.`);

  const tcc = await buildTodayCommandCenter(baseTccInput(snapshotAt));
  const item = tcc.sinceMorning.find((s) => s.stableId === key);
  assert.ok(item, 'the same row must appear in the real Today command-center payload');
  assert.equal(item.summary, `${MARKER} Your resting HR trended down this week`);
  assert.equal(item.detail, `${MARKER} Averaging 3bpm lower than last week — consistent with the extra sleep.`);
});

// ── required 6 (defensive, belt-and-suspenders): a commitment_due row is excluded even if it somehow carried a surfaceable disposition + approved content ──
test('a commitment_due row is excluded from sinceMorningForUser even when disposition/content would otherwise qualify (defensive guard, not just incidental)', async () => {
  const snapshotAt = new Date(Date.now() - 3600e3);
  const key = `${MARKER}-commitment-defensive`;
  await db.query(
    `INSERT INTO attention_log (event_key, source, domain, type, subject, disposition, reason, scores, gates, delivered, delivery_state, created_at, user_title, user_detail)
     VALUES ($1, 'commitment', 'habits', 'commitment_due', 'test-subject', 'add_to_brief', 'hypothetical', '{}'::jsonb, '{}'::jsonb, false, 'stored', now(), $2, $3)`,
    [key, `${MARKER} You committed to this`, `${MARKER} Zone 2 walk`]
  );

  const rows = await attentionStore.sinceMorningForUser({ since: snapshotAt });
  assert.ok(!rows.some((r) => r.event_key === key), 'commitment_due rows must never reach Since This Morning, regardless of disposition or content');
});

// ── required 9: an outcome/completion stamp on an older row must not make it look newly-occurred ──
test('required 9: stamping an outcome on a pre-snapshot row advances outcome_at but never created_at, so it stays excluded from sinceMorningForUser', async () => {
  const snapshotAt = new Date();
  const beforeSnapshot = new Date(snapshotAt.getTime() - 2 * 3600e3);
  const event = fromWealthCandidate(
    { title: `${MARKER} title`, body: `${MARKER} detail`, priority: 0.7, basis: { type: 'over_budget', category: `${MARKER}-cat` } },
    { asOf: beforeSnapshot }
  );
  const key = eventKey(event);

  await attentionStore.record({
    event,
    decision: { disposition: 'add_to_brief', reason: 'value 0.7 real but below bar', scores: { value: 0.7 }, gates: {} },
  });
  // Backdate created_at directly (record() always inserts at now()) so this
  // row genuinely predates the snapshot, matching the scenario the
  // requirement describes (an OLDER event later resolved/outcome-stamped).
  await db.query(`UPDATE attention_log SET created_at = $2 WHERE event_key = $1`, [key, beforeSnapshot]);

  const beforeStamp = await db.query(`SELECT created_at, outcome_at FROM attention_log WHERE event_key = $1`, [key]);
  assert.equal(beforeStamp.rows[0].outcome_at, null);

  await attentionStore.stampOutcome(event, 'accepted');

  const afterStamp = await db.query(`SELECT created_at, outcome, outcome_at FROM attention_log WHERE event_key = $1`, [key]);
  assert.equal(afterStamp.rows[0].outcome, 'accepted');
  assert.ok(afterStamp.rows[0].outcome_at, 'outcome_at must advance');
  assert.equal(new Date(afterStamp.rows[0].created_at).getTime(), beforeSnapshot.getTime(), 'created_at (the actual event occurrence) must never change from an outcome stamp');

  const rows = await attentionStore.sinceMorningForUser({ since: snapshotAt });
  assert.ok(!rows.some((r) => r.event_key === key), 'a row whose outcome was JUST stamped (outcome_at > since) but whose created_at predates the snapshot must stay excluded — newness is created_at only');
});

// ── required 5 (route/projection-level): no score/threshold/disposition/debug language anywhere in a Today payload ──
test('required 5: a full Today command-center payload built over a mixed set of attention_log rows never contains internal decision language', async () => {
  const snapshotAt = new Date(Date.now() - 3600e3);
  const reasonOnlyKey = `${MARKER}-mix-reason-only`;
  const qualifiedKey = `${MARKER}-mix-qualified`;
  await db.query(
    `INSERT INTO attention_log (event_key, source, domain, type, subject, disposition, reason, scores, gates, delivered, delivery_state, created_at)
     VALUES ($1, 'test', 'wealth', 'over_budget', 'groceries', 'add_to_brief', $2, '{"value":0.42,"urgency":0.5,"interrupt":-0.1}'::jsonb, '{"brief_default":true}'::jsonb, false, 'stored', now())`,
    [reasonOnlyKey, 'value 0.42 is real but below the interrupt/offer bar — deferred to the next briefing']
  );
  await db.query(
    `INSERT INTO attention_log (event_key, source, domain, type, subject, disposition, reason, scores, gates, delivered, delivery_state, created_at, user_title, user_detail)
     VALUES ($1, 'test', 'wealth', 'over_budget', 'dining', 'add_to_brief', 'value 0.55 offer bar', '{"value":0.55}'::jsonb, '{}'::jsonb, false, 'stored', now(), $2, $3)`,
    [qualifiedKey, `${MARKER} Dining is running over budget`, `${MARKER} $85 over this month's dining budget with a week left.`]
  );

  const tcc = await buildTodayCommandCenter(baseTccInput(snapshotAt));
  const serialized = JSON.stringify(tcc);

  assert.ok(!tcc.sinceMorning.some((s) => s.stableId === reasonOnlyKey), 'the reason-only row is excluded');
  assert.ok(tcc.sinceMorning.some((s) => s.stableId === qualifiedKey), 'the qualified row is included');

  const forbidden = [
    /interrupt\/offer bar/i, /deferred to the next briefing/i, /brief-inclusion bar/i,
    /\bdisposition\b/i, /\badd_to_brief\b/i, /\bask_question\b/i, /\bnotify_now\b/i, /\boffer_action\b/i, /\bauto_act\b/i,
    /\bthreshold\b/i, /\burgency\b/i, /\binterrupt\b/i, /\bnovelty\b/i,
    /value 0\.\d+/i, /cleared the .* bar/i,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(serialized, pattern, `Today payload must never contain internal decision language (matched ${pattern})`);
  }
});
