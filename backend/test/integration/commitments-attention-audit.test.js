// The commitments runner keeps its OWN delivery cadence and budget (its
// delicate re-nudge system is deliberately NOT routed through the attention
// policy). But the outcome loop still needs to learn which commitment kinds
// the user follows through on vs skips — so the done/skip routes write an
// audit-only outcome stamp to attention_log. These tests verify: skipping a
// commitment records an 'ignored' outcome the beliefs layer can read, marking
// one done records 'completed', and neither path is gated by (or gates) the
// policy — the HTTP response succeeds regardless.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const commitmentsStore = require('../../src/store/commitments');

const app = buildTestApp();
const createdIds = [];

async function cleanup() {
  await db.query(`DELETE FROM attention_log WHERE type = 'commitment_due'`);
  if (createdIds.length) {
    await db.query(`DELETE FROM commitments WHERE id = ANY($1)`, [createdIds]).catch(() => {});
  }
}

after(async () => {
  await cleanup();
  await closeDb();
});

// The audit stamp is fire-and-forget off the response path — poll briefly.
async function pollOutcome(subject) {
  for (let i = 0; i < 25; i++) {
    const { rows } = await db.query(
      `SELECT outcome FROM attention_log WHERE type = 'commitment_due' AND subject = $1 AND outcome IS NOT NULL`,
      [subject]
    );
    if (rows[0]) return rows[0].outcome;
    await new Promise((r) => setTimeout(r, 80));
  }
  return null;
}

test('skipping a commitment records an audit-only "ignored" outcome without blocking the response', async () => {
  await cleanup();
  const c = await commitmentsStore.create({ title: 'Test: wind down early', source: 'manual' });
  createdIds.push(c.id);
  // Seed an audited firing so stampOutcome() has a row to attach the outcome to
  // (the runner writes this when it actually pushes; here we insert directly to
  // isolate the route's stamp behavior from push infrastructure).
  const { fromCommitmentDue } = require('../../src/intelligence/events');
  const attentionStore = require('../../src/store/attention');
  await attentionStore.record({
    event: fromCommitmentDue({ commitment: c, asOf: new Date() }),
    decision: { disposition: 'notify_now', reason: 'seed', scores: { value: 0.6 }, gates: { audit_only: true } },
    delivered: true, deliveredChannel: 'push',
  });

  const res = await request(app).post(`/api/commitments/${c.id}/skip`).set(authHeader());
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const outcome = await pollOutcome(String(c.id));
  assert.equal(outcome, 'ignored', 'a user skip should be stamped as an ignored outcome for belief learning');
});

test('marking a commitment done records an audit-only "completed" outcome', async () => {
  await cleanup();
  const c = await commitmentsStore.create({ title: 'Test: 20-min walk', source: 'manual' });
  createdIds.push(c.id);
  const { fromCommitmentDue } = require('../../src/intelligence/events');
  const attentionStore = require('../../src/store/attention');
  await attentionStore.record({
    event: fromCommitmentDue({ commitment: c, asOf: new Date() }),
    decision: { disposition: 'notify_now', reason: 'seed', scores: { value: 0.6 }, gates: { audit_only: true } },
    delivered: true, deliveredChannel: 'push',
  });

  const res = await request(app).post(`/api/commitments/${c.id}/done`).set(authHeader());
  assert.equal(res.status, 200);

  const outcome = await pollOutcome(String(c.id));
  assert.equal(outcome, 'completed');
});
