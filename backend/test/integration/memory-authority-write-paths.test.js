// Regression coverage for Ticket 5: all manual context reaches the canonical
// assertion layer; a correction/deletion retires that layer too; and a
// transient compiler outage leaves a durable, recoverable job rather than a
// raw-only fact that quietly drifts from Ask/briefs.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const llm = require('../../src/llm');
const { AnthropicRefusalError } = llm;
const { processOneContextCompilationJob } = require('../../src/intelligence/context-compilation-outbox');

const app = buildTestApp();
const MARKER = `memory-authority-${Date.now()}`;
const originalGenerateText = llm.generateText;

function responseFor(rawText) {
  return {
    text: JSON.stringify({ assertions: [{
      assertionType: 'state', subject: 'user', predicate: 'reported', objectValue: rawText,
      concepts: [], domains: ['other'], eventStatus: 'occurred', temporalRef: 'today',
      explicitDate: '', correctsPriorText: '', polarity: 'neutral', evidenceSpan: rawText,
      confidence: 0.9, durationHours: 0, explicitEndDate: '',
    }] }),
    stopReason: 'end_turn', requestId: 'memory-authority-test', model: 'test-model',
  };
}

afterEach(async () => {
  llm.generateText = originalGenerateText;
  await db.query(`DELETE FROM context_compilation_jobs WHERE raw_text LIKE $1`, [`${MARKER}%`]);
  await db.query(`DELETE FROM context_relations WHERE source_assertion_id IN (SELECT id FROM context_assertions WHERE raw_text LIKE $1)`, [`${MARKER}%`]);
  // A correction/retraction may compile a replacement that points at the
  // original assertion through supersedes_assertion_id. Clear that test-only
  // link before deleting the rows, preserving the FK's real production guard.
  await db.query(
    `UPDATE context_assertions SET supersedes_assertion_id = NULL
      WHERE supersedes_assertion_id IN (SELECT id FROM context_assertions WHERE raw_text LIKE $1)`,
    [`${MARKER}%`]
  );
  await db.query(`DELETE FROM context_assertions WHERE raw_text LIKE $1`, [`${MARKER}%`]);
  await db.query(`DELETE FROM annotations WHERE label LIKE $1`, [`${MARKER}%`]);
  await db.query(`DELETE FROM day_journal WHERE text LIKE $1`, [`${MARKER}%`]);
});
after(async () => { await closeDb(); });

test('manual annotation writes one canonical assertion, and deleting it retires rather than leaves stale context', async () => {
  const label = `${MARKER} initial context`;
  llm.generateText = async () => responseFor(label);
  const created = await request(app).post('/api/annotations').set(authHeader()).send({
    startTs: new Date().toISOString(), category: 'brief_context', label,
  });
  assert.equal(created.status, 200);
  const annotationId = created.body.id;
  const before = await db.query(`SELECT id, retired_at FROM context_assertions WHERE source_annotation_id = $1`, [annotationId]);
  assert.equal(before.rows.length, 1, 'manual context is not raw-only');
  assert.equal(before.rows[0].retired_at, null);

  const deleted = await request(app).delete(`/api/annotations/${annotationId}`).set(authHeader());
  assert.equal(deleted.status, 200);
  const after = await db.query(`SELECT retired_at FROM context_assertions WHERE id = $1`, [before.rows[0].id]);
  assert.ok(after.rows[0].retired_at, 'delete retires the compiled authority too');
});

test('editing a manual annotation retires its old assertion and compiles the replacement on the same stable annotation', async () => {
  const first = `${MARKER} before correction`;
  const corrected = `${MARKER} after correction`;
  llm.generateText = async () => responseFor(first);
  const created = await request(app).post('/api/annotations').set(authHeader()).send({
    startTs: new Date().toISOString(), category: 'brief_context', label: first,
  });
  assert.equal(created.status, 200);
  llm.generateText = async () => responseFor(corrected);
  const edited = await request(app).patch(`/api/annotations/${created.body.id}`).set(authHeader()).send({ label: corrected });
  assert.equal(edited.status, 200);
  const rows = await db.query(
    `SELECT raw_text, retired_at FROM context_assertions WHERE source_annotation_id = $1 ORDER BY created_at`, [created.body.id]
  );
  assert.equal(rows.rows.length, 2);
  assert.ok(rows.rows[0].retired_at, 'old compiled wording is no longer eligible');
  assert.equal(rows.rows[1].raw_text, corrected);
  assert.equal(rows.rows[1].retired_at, null);
});

test('a contextual retraction retires the original compiled fact, not only its raw annotation', async () => {
  const plan = `${MARKER} drinks with friends tonight`;
  const retraction = `I did not end up going for ${MARKER} drinks with friends tonight. Please forget that context.`;
  llm.generateText = async () => responseFor(plan);
  const created = await request(app).post('/api/annotations').set(authHeader()).send({
    startTs: new Date().toISOString(), category: 'brief_context', label: plan,
  });
  assert.equal(created.status, 200);
  const before = await db.query(
    `SELECT id, retired_at FROM context_assertions WHERE source_annotation_id = $1`, [created.body.id]
  );
  assert.equal(before.rows.length, 1);

  llm.generateText = async () => responseFor(retraction);
  const answered = await request(app).post('/api/briefing/context').set(authHeader()).send({ answer: retraction });
  assert.equal(answered.status, 200);
  const after = await db.query(`SELECT retired_at FROM context_assertions WHERE id = $1`, [before.rows[0].id]);
  assert.ok(after.rows[0].retired_at, 'the retracted fact is no longer eligible for Ask or the next brief');
});

test('a compiler outage commits raw context plus one durable job; retry later creates the assertion exactly once', async () => {
  const label = `${MARKER} retry me`;
  llm.generateText = async () => { throw new AnthropicRefusalError('temporary', { requestId: 'retry' }); };
  const created = await request(app).post('/api/annotations').set(authHeader()).send({
    startTs: new Date().toISOString(), category: 'brief_context', label,
  });
  assert.equal(created.status, 200, 'the raw audit record still saves during a provider incident');
  const jobs = await db.query(`SELECT id, status FROM context_compilation_jobs WHERE source_annotation_id = $1`, [created.body.id]);
  assert.equal(jobs.rows.length, 1);
  assert.equal(jobs.rows[0].status, 'pending');

  llm.generateText = async () => responseFor(label);
  const processed = await processOneContextCompilationJob({ jobId: jobs.rows[0].id });
  assert.equal(processed.succeeded, true);
  const [job, assertions] = await Promise.all([
    db.query(`SELECT status FROM context_compilation_jobs WHERE id = $1`, [jobs.rows[0].id]),
    db.query(`SELECT id FROM context_assertions WHERE source_annotation_id = $1 AND retired_at IS NULL`, [created.body.id]),
  ]);
  assert.equal(job.rows[0].status, 'succeeded');
  assert.equal(assertions.rows.length, 1, 'the durable retry has one idempotent structured result');
});

test('a generic chief-brief answer also queues compilation instead of silently becoming raw-only', async () => {
  const answer = `${MARKER} chief brief retry me`;
  llm.generateText = async () => { throw new AnthropicRefusalError('temporary', { requestId: 'briefing-retry' }); };
  const saved = await request(app).post('/api/briefing/context').set(authHeader()).send({ answer });
  assert.equal(saved.status, 200, 'a generic answer remains an honest saved audit record during a provider incident');
  const job = await db.query(
    `SELECT source_annotation_id, status FROM context_compilation_jobs WHERE raw_text = $1`, [answer]
  );
  assert.equal(job.rows.length, 1, 'the generic brief route uses the same durable retry ledger');
  assert.ok(job.rows[0].source_annotation_id);
  assert.equal(job.rows[0].status, 'pending');
});
