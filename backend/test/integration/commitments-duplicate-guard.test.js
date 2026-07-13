// Bug: a voice-set reminder ("cool the bedroom before sleep") and a second,
// differently-worded reminder for the same intent ("cool the bedroom before
// bed") both landed on the Today card a minute apart, with no notification
// in between — either a realtime tool call double-firing for one utterance,
// or a dropped-response client retry re-sending the same instruction.
// commitmentsStore.create() had no idempotency guard at all: every call
// unconditionally inserted a new row.
//
// Fixed with a narrow, zero-risk guard: an EXACT (case-insensitive) title
// repeat, same source, within a short window, returns the existing open
// commitment instead of inserting a duplicate. Deliberately exact-match only
// (not fuzzy) — a fuzzy guard could silently swallow a genuine correction
// ("actually make that 10:45") instead of recording it.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const commitmentsStore = require('../../src/store/commitments');

const TAG = `dup-guard-${Date.now()}`;

afterEach(async () => {
  await db.query(`DELETE FROM commitments WHERE title LIKE $1`, [`%${TAG}%`]);
});
after(async () => { await closeDb(); });

test('an exact-title repeat from the same source within the window returns the existing commitment, not a new row', async () => {
  const first = await commitmentsStore.create({ title: `Cool the bedroom before sleep ${TAG}`, source: 'voice' });
  const second = await commitmentsStore.create({ title: `Cool the bedroom before sleep ${TAG}`, source: 'voice' });
  assert.equal(second.id, first.id, 'the second call must return the SAME row, not insert a duplicate');

  const { rows } = await db.query(`SELECT count(*)::int AS n FROM commitments WHERE title = $1`, [`Cool the bedroom before sleep ${TAG}`]);
  assert.equal(rows[0].n, 1, 'exactly one row exists in the database');
});

test('the guard is case-insensitive on the title', async () => {
  const first = await commitmentsStore.create({ title: `Call The Dentist ${TAG}`, source: 'voice' });
  const second = await commitmentsStore.create({ title: `call the dentist ${TAG}`, source: 'voice' });
  assert.equal(second.id, first.id);
});

test('a genuinely different title (a paraphrase or correction) still creates a separate commitment', async () => {
  const first = await commitmentsStore.create({ title: `Cool the bedroom before sleep ${TAG}`, source: 'voice' });
  const second = await commitmentsStore.create({ title: `Cool the bedroom before bed ${TAG}`, source: 'voice' });
  assert.notEqual(second.id, first.id, 'a differently-worded commitment must not be silently dropped');
});

test('the same title from a different source is not treated as a duplicate', async () => {
  const first = await commitmentsStore.create({ title: `Book the doctor ${TAG}`, source: 'voice' });
  const second = await commitmentsStore.create({ title: `Book the doctor ${TAG}`, source: 'manual' });
  assert.notEqual(second.id, first.id);
});

test('once the first commitment is done, a repeat of the same title creates a fresh one (not blocked forever)', async () => {
  const first = await commitmentsStore.create({ title: `Take out the trash ${TAG}`, source: 'voice' });
  await commitmentsStore.markDone(first.id);
  const second = await commitmentsStore.create({ title: `Take out the trash ${TAG}`, source: 'voice' });
  assert.notEqual(second.id, first.id, 'a NEW instance of a recurring ask must not be swallowed by an already-completed one');
});
