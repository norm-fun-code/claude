// P3 hardening: the Realtime voice context package is temporally grounded.
//
// Before this, buildContextPackage put selfModel.slice(0, 2000) — a blob that
// mixes durable facts with DATED journal entries and annotations — under a
// "WHAT YOU KNOW ABOUT THIS PERSON RIGHT NOW" header. The model could narrate
// something logged days ago ("you slept hot last night") as current. Now the
// package is split into DURABLE (timeless) and CURRENT (each item dated), old
// episodic entries are excluded from the current section, and the system
// prompt forbids time words unless backed by a dated current item or a fresh
// get_ tool result.
const test = require('node:test');
const { after, afterEach } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const { buildContextPackage, composeInstructions } = require('../../src/routes/realtime');
const beliefsStore = require('../../src/store/beliefs');
const dayJournalStore = require('../../src/store/dayJournal');

const TAG = `ZZrt-${Date.now()}`;

function ymd(d) { return d.toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/New_York' }); }

async function cleanup() {
  await db.query(`DELETE FROM beliefs WHERE dedup_key LIKE $1`, [`${TAG}%`]);
  await db.query(`DELETE FROM day_journal WHERE text LIKE $1`, [`%${TAG}%`]);
}
afterEach(cleanup);
after(async () => { await cleanup(); await closeDb(); });

test('a three-day-old "slept hot" journal entry cannot enter the CURRENT (dated) section', async () => {
  const now = new Date();
  const threeDaysAgo = ymd(new Date(now.getTime() - 3 * 864e5));
  await dayJournalStore.create({ text: `${TAG} slept hot and restless`, entryDate: threeDaysAgo, source: 'test' });

  const pkg = await buildContextPackage({ now });
  assert.ok(!pkg.current.includes('slept hot'), 'a 3-day-old note must not appear in the current section');
  assert.ok(!pkg.current.includes(TAG), 'nothing from 3 days ago is presented as current');
});

test('today\'s and yesterday\'s journal notes DO appear, each explicitly dated', async () => {
  const now = new Date();
  const today = ymd(now);
  const yesterday = ymd(new Date(now.getTime() - 864e5));
  await dayJournalStore.create({ text: `${TAG} big valuation call`, entryDate: today, source: 'test' });
  await dayJournalStore.create({ text: `${TAG} family dinner`, entryDate: yesterday, source: 'test' });

  const pkg = await buildContextPackage({ now });
  assert.match(pkg.current, new RegExp(`TODAY \\(${today}\\)`), 'today\'s note is dated TODAY');
  assert.match(pkg.current, new RegExp(`YESTERDAY \\(${yesterday}\\)`), 'yesterday\'s note is dated YESTERDAY');
});

test('durable beliefs (with provenance) remain available in the DURABLE section', async () => {
  await beliefsStore.upsertBelief({
    kind: 'user_statement', dedupKey: `${TAG}:cold-showers`,
    statement: `${TAG} They take cold showers unless they are sick`,
    evidence: { source: 'stated' },
  });
  const pkg = await buildContextPackage();
  assert.ok(pkg.durable.includes(`${TAG} They take cold showers`), 'the durable belief is present');
  assert.ok(pkg.durable.includes('[stated]'), 'its provenance is shown');
});

test('the assembled instructions no longer use a "RIGHT NOW" self-model blob, and forbid unbacked time words', async () => {
  const pkg = await buildContextPackage();
  const instructions = composeInstructions(pkg);
  assert.ok(!instructions.includes('RIGHT NOW:'), 'the old "…RIGHT NOW" header is gone');
  // The temporal contract explicitly forbids the leak phrases and points at tools.
  for (const phrase of ['last night', 'this morning', 'currently', 'again']) {
    assert.ok(instructions.includes(phrase), `the forbidden-words rule names "${phrase}"`);
  }
  assert.match(instructions, /call the matching get_ tool/i, 'current-state questions are directed at fresh tools');
  assert.match(instructions, /DURABLE facts are ongoing truths/i, 'durable vs current split is stated');
});

test('missing / empty stores fail soft — the package and instructions still build', async () => {
  // No seeded data for this run (afterEach cleaned up). buildContextPackage must
  // still return a well-formed package and composeInstructions a usable prompt.
  const pkg = await buildContextPackage();
  assert.equal(typeof pkg.durable, 'string');
  assert.equal(typeof pkg.current, 'string');
  const instructions = composeInstructions(pkg);
  assert.ok(instructions.startsWith('You are NormOS') || instructions.includes('NormOS'), 'persona still present');
  assert.match(instructions, /TODAY'S DATE is \d{4}-\d{2}-\d{2}/, 'the date anchor is always present');
});
