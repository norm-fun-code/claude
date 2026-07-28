// Voice-redesign acceptance scenarios that need a real Postgres: binding a
// voice reference ("this", "that") to a STABLE canonical row (never text
// matching), completing a commitment exactly once through the same
// idempotency guard the Realtime/push-to-talk tool paths use, and temporal
// binding ("I drank last night") resolving against the session's own local
// timestamp rather than the server's request-arrival clock.
const test = require('node:test');
const { after, afterEach, before } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');

const { resolveSelection } = require('../../src/chat/voiceContext');
const { executeAction } = require('../../src/chat/executeAction');
const commitmentsStore = require('../../src/store/commitments');
const findingsStore = require('../../src/store/findings');
const idempotency = require('../../src/chat/voiceIdempotency');

async function cleanup() {
  await db.query(`DELETE FROM commitments WHERE title LIKE 'ZZvoice%'`);
  await db.query(`DELETE FROM findings WHERE title LIKE 'ZZvoice%'`);
  await db.query(`DELETE FROM annotations WHERE label LIKE 'ZZvoice%'`);
}

before(async () => { await cleanup(); });
afterEach(async () => { await cleanup(); idempotency._reset(); });
after(async () => { await closeDb(); });

test('required: from a Today commitment, resolveSelection binds to the EXACT stable row by id, not by title text', async () => {
  const row = await commitmentsStore.create({ title: 'ZZvoice call the dentist', source: 'test' });
  const resolved = await resolveSelection({ kind: 'commitment', id: row.id });
  assert.equal(resolved.found, true);
  assert.equal(resolved.data.id, row.id);
  assert.match(resolved.summary, /ZZvoice call the dentist/);
});

test('required: "mark this done" (complete_commitment) mutates the CORRECT commitment exactly once, even under a duplicate/retried call', async () => {
  const row = await commitmentsStore.create({ title: 'ZZvoice mark this done target', source: 'test' });
  const other = await commitmentsStore.create({ title: 'ZZvoice a different commitment', source: 'test' });

  const key = idempotency.keyFor({ sessionId: 'sess-1', turnId: 'turn-1', action: 'complete_commitment', argsHash: idempotency.hashArgs({ commitmentId: row.id }) });
  const call = () => idempotency.once(key, () => executeAction({ action: 'complete_commitment', commitmentId: row.id }));

  const first = await call();
  const retry = await call(); // simulates a client retry / duplicate tool call for the SAME turn

  assert.equal(first.result.done, true);
  assert.match(first.result.description, /ZZvoice mark this done target/);
  assert.equal(retry.fromCache, true, 'the retry must be served from cache, not re-executed');

  const { rows } = await db.query(`SELECT status FROM commitments WHERE id = $1`, [row.id]);
  assert.equal(rows[0].status, 'done');
  const { rows: otherRows } = await db.query(`SELECT status FROM commitments WHERE id = $1`, [other.id]);
  assert.equal(otherRows[0].status, 'open', 'the OTHER commitment must be untouched — exact id binding, not "the most recent one"');
});

test('completing an ALREADY-done commitment a second time (no dedup key involved) is a safe no-op, not a re-grade', async () => {
  const row = await commitmentsStore.create({ title: 'ZZvoice already done', source: 'test' });
  await commitmentsStore.markDone(row.id);
  const result = await executeAction({ action: 'complete_commitment', commitmentId: row.id });
  assert.equal(result.done, false);
  assert.match(result.description, /already marked done/);
});

test('required: from a Wealth (or Health) anomaly, resolveSelection binds to the EXACT insight by its stable anomalyKey, not by title/category text', async () => {
  const anomalyKey = 'anomaly:ZZvoice-dining:2026-07-20';
  await findingsStore.createFinding({
    type: 'spending_anomaly', domains: ['wealth'], status: 'open',
    title: 'ZZvoice Dining spend spiked', detail: 'Dining was $412 in the last 7 days, well above your $180 average.',
    evidence: { kind: 'anomaly', anomalyKey, category: 'Dining', periodStart: '2026-07-14', periodEnd: '2026-07-20' },
  });
  // A decoy finding with a similar TITLE but a different anomalyKey — proves
  // the lookup binds by the stable key, not by matching what the words say.
  await findingsStore.createFinding({
    type: 'spending_anomaly', domains: ['wealth'], status: 'open',
    title: 'ZZvoice Dining spend spiked again', detail: 'A different period.',
    evidence: { kind: 'anomaly', anomalyKey: 'anomaly:ZZvoice-dining:2026-06-01', category: 'Dining' },
  });

  const resolved = await resolveSelection({ kind: 'insight', id: anomalyKey });
  assert.equal(resolved.found, true);
  assert.equal(resolved.data.evidence.anomalyKey, anomalyKey);
  assert.equal(resolved.data.evidence.periodStart, '2026-07-14');
  assert.match(resolved.summary, /Dining spend spiked/);
});

test('required: temporal binding — a context statement is compiled against the SESSION\'s local timestamp, not the server request-arrival clock', async () => {
  // Simulates "I drank last night" spoken during a Realtime session whose
  // actual local moment was 11:58pm on the 27th, arriving at this backend a
  // few seconds into the 28th — executeAction must anchor "today"/annotation
  // start_ts to the SESSION's now, not whatever Date.now() reads when the
  // HTTP request happens to land.
  const sessionNow = new Date('2026-07-27T23:58:00.000-04:00');
  await executeAction(
    { action: 'add_context', text: 'ZZvoice drank a glass of wine last night' },
    { now: sessionNow }
  );
  const { rows } = await db.query(
    `SELECT start_ts FROM annotations WHERE label = $1`,
    ['ZZvoice drank a glass of wine last night']
  );
  assert.equal(rows.length, 1);
  assert.equal(new Date(rows[0].start_ts).getTime(), sessionNow.getTime(), 'the annotation must be anchored to the SESSION timestamp passed in, not the request-arrival time');
});
