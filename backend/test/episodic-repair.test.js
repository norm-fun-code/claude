// Unit coverage for the one-time backfill's reconstruction logic — see
// scripts/repair-unbounded-episodic-assertions.js and
// intelligence/episodic-repair.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractDurationHours, extractEndDateStr, reconstructEffectiveEnd } = require('../src/intelligence/episodic-repair');

const TZ = 'America/New_York';
const RECORDED = new Date('2026-07-22T23:00:00Z'); // Wed 7pm ET

test('extractDurationHours: finds an explicit hour/day duration', () => {
  assert.equal(extractDurationHours('25 hour fast'), 25);
  assert.equal(extractDurationHours('a 48-hour trip'), 48);
  assert.equal(extractDurationHours('gone for 3 days'), 72);
  assert.equal(extractDurationHours('I am traveling'), null);
});

test('extractEndDateStr: only the clear tomorrow/today cases resolve; a weekday name does not', () => {
  assert.equal(extractEndDateStr({ text: 'fast through tomorrow', recordedAt: RECORDED, tz: TZ }), '2026-07-23');
  assert.equal(extractEndDateStr({ text: 'until today', recordedAt: RECORDED, tz: TZ }), '2026-07-22');
  assert.equal(extractEndDateStr({ text: 'until Friday', recordedAt: RECORDED, tz: TZ }), null, 'a weekday name must not be guessed');
  assert.equal(extractEndDateStr({ text: 'no end phrase here', recordedAt: RECORDED, tz: TZ }), null);
});

test('reconstructEffectiveEnd: the reported case — "25 hour fast starting tonight" reconstructs a real ~25h window', () => {
  const end = reconstructEffectiveEnd({ rawText: '25 hour fast starting tonight', effectiveStart: RECORDED, recordedAt: RECORDED, tz: TZ });
  assert.ok(end instanceof Date);
  const hours = (end.getTime() - RECORDED.getTime()) / 3600000;
  assert.equal(hours, 25);
});

test('reconstructEffectiveEnd: "through tomorrow" reconstructs to the end of the next local day', () => {
  const end = reconstructEffectiveEnd({ rawText: 'fast starting tonight through tomorrow', effectiveStart: RECORDED, recordedAt: RECORDED, tz: TZ });
  assert.ok(end instanceof Date);
  assert.equal(end.toLocaleDateString('en-CA', { timeZone: TZ }), '2026-07-23');
});

test('reconstructEffectiveEnd: no duration/end signal in the text -> null (never guesses)', () => {
  assert.equal(reconstructEffectiveEnd({ rawText: 'I am traveling', effectiveStart: RECORDED, recordedAt: RECORDED, tz: TZ }), null);
});

test('reconstructEffectiveEnd: a hallucinated-sounding but genuinely absent signal stays null even with odd phrasing', () => {
  assert.equal(reconstructEffectiveEnd({ rawText: 'on a trip', effectiveStart: RECORDED, recordedAt: RECORDED, tz: TZ }), null);
});

test('reconstructEffectiveEnd: missing effectiveStart or recordedAt returns null rather than throwing', () => {
  assert.equal(reconstructEffectiveEnd({ rawText: '25 hour fast', effectiveStart: null, recordedAt: RECORDED, tz: TZ }), null);
  assert.equal(reconstructEffectiveEnd({ rawText: '25 hour fast', effectiveStart: RECORDED, recordedAt: null, tz: TZ }), null);
});
