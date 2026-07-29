// Cross-day lifecycle fix — pure canonical-clock helpers (see useCanonicalDay
// for the React hook wrapping these with AppState/timer plumbing).
//   node --experimental-strip-types --test src/lib/canonicalDay.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalLocalDate, msUntilNextLocalMidnight, DEFAULT_CANONICAL_TZ } from './canonicalDay.ts';

test('canonicalLocalDate defaults to America/New_York', () => {
  // 04:30 UTC on July 29 is already "today" (July 29) in New York (EDT,
  // UTC-4) but still "yesterday" (July 28) in Los Angeles (PDT, UTC-7) —
  // proves the default zone is genuinely being used, not just UTC.
  const instant = new Date('2026-07-29T04:30:00.000Z');
  assert.equal(canonicalLocalDate(instant), '2026-07-29');
  assert.equal(canonicalLocalDate(instant, DEFAULT_CANONICAL_TZ), '2026-07-29');
  assert.equal(canonicalLocalDate(instant, 'America/Los_Angeles'), '2026-07-28');
});

test('canonicalLocalDate: a traveling device (different physical TZ) still gets the CANONICAL day when a TZ is passed explicitly', () => {
  const instant = new Date('2026-07-29T04:30:00.000Z');
  assert.equal(canonicalLocalDate(instant, 'America/New_York'), '2026-07-29');
});

test('msUntilNextLocalMidnight: just before midnight in the canonical zone returns a small positive number', () => {
  // 03:59:00 UTC = 23:59:00 EDT (UTC-4) on the previous calendar day.
  const justBeforeMidnight = new Date('2026-07-29T03:59:00.000Z');
  const ms = msUntilNextLocalMidnight(justBeforeMidnight, 'America/New_York');
  assert.ok(ms > 0, 'always positive — never fires in the past');
  assert.ok(ms <= 65000, `expected close to 60s remaining, got ${ms}ms`);
});

test('msUntilNextLocalMidnight: right after midnight returns close to a full day', () => {
  // 04:00:05 UTC = 00:00:05 EDT — 5 seconds into the new day.
  const justAfterMidnight = new Date('2026-07-29T04:00:05.000Z');
  const ms = msUntilNextLocalMidnight(justAfterMidnight, 'America/New_York');
  const twentyFourHours = 24 * 60 * 60 * 1000;
  assert.ok(ms > twentyFourHours - 10000 && ms <= twentyFourHours + 2000, `expected ~24h remaining, got ${ms}ms`);
});

test('msUntilNextLocalMidnight is always at least 1 second (never zero/negative, safe to pass to setTimeout)', () => {
  const exactlyMidnight = new Date('2026-07-29T04:00:00.000Z');
  assert.ok(msUntilNextLocalMidnight(exactlyMidnight, 'America/New_York') >= 1000);
});
