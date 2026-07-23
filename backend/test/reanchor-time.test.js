// Re-anchoring relative time words in a prior-day context note — the fix for
// "context timing has been consistently off": a note entered last night
// ("25 hour fast starting tonight") echoed verbatim into the next day's brief
// as "starting tonight" instead of "last night".
const test = require('node:test');
const assert = require('node:assert/strict');
const { reanchorRelativeTime } = require('../src/intelligence/reanchor-time');

const TZ = 'America/New_York';
// Entry: Sunday 2026-07-19 ~9pm ET (01:00Z Mon). Read: Monday 2026-07-20 ~10am ET.
const SUN_EVENING = new Date('2026-07-20T01:00:00Z'); // still Sun Jul 19 in ET
const MON_MORNING = new Date('2026-07-20T14:00:00Z'); // Mon Jul 20 in ET

test('THE reported bug: "25 hour fast starting tonight" entered last night reads as "last night" today', () => {
  const out = reanchorRelativeTime('25 hour fast starting tonight', { fromDate: SUN_EVENING, now: MON_MORNING, tz: TZ });
  assert.equal(out, '25 hour fast starting last night');
});

test('a note entered TODAY is left completely untouched (its relative words are still correct)', () => {
  const out = reanchorRelativeTime('25 hour fast starting tonight', { fromDate: MON_MORNING, now: MON_MORNING, tz: TZ });
  assert.equal(out, '25 hour fast starting tonight');
});

test('a note dated in the future is left untouched (never rewrites forward)', () => {
  const out = reanchorRelativeTime('big meeting tomorrow', { fromDate: MON_MORNING, now: SUN_EVENING, tz: TZ });
  assert.equal(out, 'big meeting tomorrow');
});

test('tomorrow -> today, today -> yesterday for a one-day-old note', () => {
  assert.equal(reanchorRelativeTime('deadline is tomorrow', { fromDate: SUN_EVENING, now: MON_MORNING, tz: TZ }), 'deadline is today');
  assert.equal(reanchorRelativeTime('fasting today', { fromDate: SUN_EVENING, now: MON_MORNING, tz: TZ }), 'fasting yesterday');
});

test('this morning/evening re-anchor to yesterday morning/evening', () => {
  assert.equal(reanchorRelativeTime('felt off this morning', { fromDate: SUN_EVENING, now: MON_MORNING, tz: TZ }), 'felt off yesterday morning');
  assert.equal(reanchorRelativeTime('drinks this evening', { fromDate: SUN_EVENING, now: MON_MORNING, tz: TZ }), 'drinks yesterday evening');
});

test('a replacement that itself contains a relative word is NOT re-scanned (single pass)', () => {
  // "fasting today and tomorrow" one day old -> "fasting yesterday and today":
  // the injected "today" from "tomorrow" must NOT then be turned into "yesterday".
  const out = reanchorRelativeTime('fasting today and tomorrow', { fromDate: SUN_EVENING, now: MON_MORNING, tz: TZ });
  assert.equal(out, 'fasting yesterday and today');
});

test('two-day-old note uses weekday phrasing, not "yesterday"', () => {
  // Entry Sat Jul 18 evening, read Mon Jul 20.
  const satEvening = new Date('2026-07-19T01:00:00Z'); // Sat Jul 18 ET
  assert.equal(reanchorRelativeTime('25h fast starting tonight', { fromDate: satEvening, now: MON_MORNING, tz: TZ }), '25h fast starting Saturday night');
  assert.equal(reanchorRelativeTime('due tomorrow', { fromDate: satEvening, now: MON_MORNING, tz: TZ }), 'due yesterday');
});

test('case-insensitive match; unrelated text and "last night"/"yesterday"-style already-past words are preserved verbatim where correct', () => {
  assert.equal(reanchorRelativeTime('Tonight I fast', { fromDate: SUN_EVENING, now: MON_MORNING, tz: TZ }), 'last night I fast');
  // "last night" is not in the token set — it stays correct as read today and is never touched.
  assert.equal(reanchorRelativeTime('drank last night', { fromDate: SUN_EVENING, now: MON_MORNING, tz: TZ }), 'drank last night');
});

test('missing/invalid inputs return the text unchanged (safe to wrap any label)', () => {
  assert.equal(reanchorRelativeTime('tonight', { fromDate: null }), 'tonight');
  assert.equal(reanchorRelativeTime('tonight', { fromDate: 'not-a-date', now: MON_MORNING, tz: TZ }), 'tonight');
  assert.equal(reanchorRelativeTime('', { fromDate: SUN_EVENING }), '');
  assert.equal(reanchorRelativeTime(null, { fromDate: SUN_EVENING }), null);
});

test('DST-safe: a late-evening instant near UTC midnight resolves to the correct local day', () => {
  // 2026-03-08 is a US DST spring-forward day. Entry Sat Mar 7 ~11pm ET, read Sun Mar 8 ~10am ET.
  const satLate = new Date('2026-03-08T04:00:00Z'); // Sat Mar 7 11pm EST
  const sunAm = new Date('2026-03-08T14:00:00Z');   // Sun Mar 8 10am EDT
  assert.equal(reanchorRelativeTime('fast starts tonight', { fromDate: satLate, now: sunAm, tz: TZ }), 'fast starts last night');
});
