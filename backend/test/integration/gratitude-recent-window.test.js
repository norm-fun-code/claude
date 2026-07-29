// Evening/wealth hardening pass, item 7: store/gratitudeLogs.js's recent()
// used to have NO date boundary at all — "5 most recent" meant the 5 most
// recent rows EVER, however old, so a months-old entry could be presented in
// tonight's evening-brief "presence beat" reflection with no indication it
// wasn't from today (the prompt frames whatever it's given as "recent
// gratitude notes" and asks the model to echo it back as if fresh).
//
// recent() now REQUIRES an explicit `sinceYmd` lookback boundary (the caller
// — notify/evening-brief.js — passes its own canonical local "today" minus a
// week), so a genuine gap in logging correctly produces nothing to reflect
// instead of resurrecting old text.
'use strict';
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { closeDb } = require('./helpers');
const gratitudeLogs = require('../../src/store/gratitudeLogs');

const TAG = `gratitude-${Date.now()}`;

after(async () => {
  await db.query(`DELETE FROM gratitude_logs WHERE text LIKE $1`, [`${TAG}%`]);
  await closeDb();
});

function ymd(d) {
  return d.toISOString().slice(0, 10);
}
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return ymd(d);
}

test('required: recent() throws without an explicit sinceYmd boundary (fail-closed, never silently unbounded)', async () => {
  await assert.rejects(() => gratitudeLogs.recent(5), /sinceYmd/);
});

test('required: an old gratitude entry outside the lookback window is excluded — a real logging gap produces nothing to reflect, never a resurrected old entry', async (t) => {
  const oldDate = daysAgo(90);
  await gratitudeLogs.upsert({ logDate: oldDate, text: `${TAG} a months-old entry` });
  t.after(async () => { await db.query(`DELETE FROM gratitude_logs WHERE log_date = $1`, [oldDate]); });

  const sinceYmd = daysAgo(7);
  const rows = await gratitudeLogs.recent(5, { sinceYmd });
  assert.ok(!rows.some((r) => String(r.text).includes(`${TAG} a months-old entry`)), 'a 90-day-old entry must never appear in a 7-day lookback window');
});

test('required: a genuinely recent gratitude entry (within the lookback window) IS returned', async (t) => {
  const recentDate = daysAgo(1);
  await gratitudeLogs.upsert({ logDate: recentDate, text: `${TAG} a recent entry` });
  t.after(async () => { await db.query(`DELETE FROM gratitude_logs WHERE log_date = $1`, [recentDate]); });

  const sinceYmd = daysAgo(7);
  const rows = await gratitudeLogs.recent(5, { sinceYmd });
  assert.ok(rows.some((r) => String(r.text).includes(`${TAG} a recent entry`)), 'an entry from yesterday must survive a 7-day lookback window');
});

test('required: an entry exactly ON the lookback boundary date is included (inclusive boundary)', async (t) => {
  const boundaryDate = daysAgo(7);
  await gratitudeLogs.upsert({ logDate: boundaryDate, text: `${TAG} boundary entry` });
  t.after(async () => { await db.query(`DELETE FROM gratitude_logs WHERE log_date = $1`, [boundaryDate]); });

  const rows = await gratitudeLogs.recent(5, { sinceYmd: boundaryDate });
  assert.ok(rows.some((r) => String(r.text).includes(`${TAG} boundary entry`)), 'the boundary date itself must be included (>=, not >)');
});
