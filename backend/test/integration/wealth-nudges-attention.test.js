// Wealth nudges (over-budget categories, budget pacing, new recurring
// charges) used to decide delivery for itself (its own recentlySentKeys(2)
// pre-filter + a direct send loop). It now builds normalized AttentionEvents
// and routes them through the Attention Policy (notify/dispatch.js), same as
// watch.js and notify/run.js. These tests stub the Monarch service layer and
// verify: a genuine over-budget category judges to a user-facing disposition
// and is recorded in attention_log, a repeat of the SAME fact the same month
// is suppressed by the policy's cooldown (not a manual "already sent" flag),
// and an under-threshold/on-pace category generates nothing.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const monarchWealth = require('../../src/services/monarch-wealth');
const { runWealthNudges } = require('../../src/intelligence/wealth-nudges');
const { closeDb } = require('./helpers');

const ORIGINAL_IS_CONFIGURED = monarchWealth.isConfigured;
const ORIGINAL_PACING = monarchWealth.getBudgetPacing;
const ORIGINAL_RECURRING = monarchWealth.getRecurring;

async function cleanupLedgers() {
  await db.query(`DELETE FROM attention_log WHERE event_key LIKE 'wealth:%'`);
  await db.query(`DELETE FROM nudges WHERE dedup_key LIKE 'over_budget:%' OR dedup_key LIKE 'budget_pace:%' OR dedup_key LIKE 'new_recurring:%'`);
}

function stub({ pacing = null, recurring = null } = {}) {
  monarchWealth.isConfigured = () => true;
  monarchWealth.getBudgetPacing = async () => pacing;
  monarchWealth.getRecurring = async () => recurring;
}

afterEach(async () => {
  monarchWealth.isConfigured = ORIGINAL_IS_CONFIGURED;
  monarchWealth.getBudgetPacing = ORIGINAL_PACING;
  monarchWealth.getRecurring = ORIGINAL_RECURRING;
  await cleanupLedgers();
});

after(async () => {
  await cleanupLedgers();
  await closeDb();
});

test('an over-budget category judges to a user-facing disposition, recorded in attention_log', async () => {
  await cleanupLedgers();
  stub({
    pacing: {
      dayOfMonth: 20, daysInMonth: 30,
      lines: [{ category: 'Dining', overBudget: true, actual: 900, budget: 600, remaining: -300, pace: 1.5 }],
    },
  });

  const r = await runWealthNudges({ send: false, force: true });
  assert.equal(r.generated, 1);
  assert.ok(['notify_now', 'add_to_brief', 'offer_action'].includes(r.nudges[0].disposition), `expected a user-facing disposition, got ${r.nudges[0].disposition}`);

  const { rows } = await db.query(`SELECT domain, type, subject FROM attention_log WHERE event_key LIKE 'wealth:over_budget:Dining:%'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].domain, 'wealth');
  assert.equal(rows[0].type, 'over_budget');
  assert.equal(rows[0].subject, 'Dining');
});

test('the same over-budget category again the same month is suppressed by the policy cooldown', async () => {
  await cleanupLedgers();
  stub({
    pacing: {
      dayOfMonth: 20, daysInMonth: 30,
      lines: [{ category: 'Dining', overBudget: true, actual: 900, budget: 600, remaining: -300, pace: 1.5 }],
    },
  });

  const first = await runWealthNudges({ send: false, force: true });
  assert.ok(['notify_now', 'add_to_brief', 'offer_action'].includes(first.nudges[0].disposition));

  const second = await runWealthNudges({ send: false, force: true });
  assert.equal(second.nudges[0].disposition, 'store_silently', 'the same over-budget fact must not double-surface the same month');
});

test('a category on pace but not yet over budget generates a lower-urgency event, not silence', async () => {
  await cleanupLedgers();
  stub({
    pacing: {
      dayOfMonth: 10, daysInMonth: 30,
      lines: [{ category: 'Travel', overBudget: false, actual: 300, budget: 400, remaining: 100, pace: 1.8 }],
    },
  });

  const r = await runWealthNudges({ send: false, force: true });
  assert.equal(r.generated, 1);
  const { rows } = await db.query(`SELECT type FROM attention_log WHERE event_key LIKE 'wealth:budget_pace:Travel:%'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'budget_pace');
});

test('a category within budget and on pace generates nothing', async () => {
  await cleanupLedgers();
  stub({
    pacing: {
      dayOfMonth: 10, daysInMonth: 30,
      lines: [{ category: 'Groceries', overBudget: false, actual: 200, budget: 500, remaining: 300, pace: 0.9 }],
    },
  });

  const r = await runWealthNudges({ send: false, force: true });
  assert.equal(r.generated ?? 0, 0);
});

test('when Monarch is not configured, the run is skipped without touching the ledger', async () => {
  monarchWealth.isConfigured = () => false;
  const r = await runWealthNudges({ send: false });
  assert.equal(r.skipped, 'monarch_not_configured');
  assert.equal(r.sent, 0);
});
