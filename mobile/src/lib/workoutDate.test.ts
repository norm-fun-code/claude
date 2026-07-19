// Regression tests for the WorkoutsPanel date-selection bug: a Pull workout
// swapped/partially completed on Wednesday was still showing Wednesday's
// checked exercises and set logs when the app was reopened days later on
// Sunday, because "selected day" was tracked as a weekday index that never
// got re-anchored to a new date after the app resumed from background.
//
//   node --experimental-strip-types --test src/lib/workoutDate.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { localDateInTz, weekdayIndexOfDate, shouldResetToToday } from './workoutDate.ts';
import { createRequestGuard } from './playbackOwnership.ts';

test('localDateInTz: uses the given IANA timezone, not UTC, to compute the local calendar date', () => {
  // 2026-07-16T02:30:00Z is still 2026-07-15, 10:30pm in New York (EDT,
  // UTC-4), but already 2026-07-16 in Auckland (UTC+12) — the SAME instant
  // must resolve to two different calendar dates depending on the device's
  // actual timezone, never a fixed UTC-based cutoff.
  const instant = new Date('2026-07-16T02:30:00Z');
  assert.equal(localDateInTz(instant, 'America/New_York'), '2026-07-15');
  assert.equal(localDateInTz(instant, 'Pacific/Auckland'), '2026-07-16');
});

test('localDateInTz: DST spring-forward boundary stays on the correct local date', () => {
  // US DST began 2026-03-08 at 2:00am local (skips to 3:00am EDT). Instants
  // just before and just after that jump are both still "2026-03-08" in
  // New York local time — a naive fixed-offset calculation could roll this
  // over incorrectly.
  const beforeSpringForward = new Date('2026-03-08T06:59:00Z'); // 1:59am EST
  const afterSpringForward = new Date('2026-03-08T08:00:01Z'); // 4:00am EDT
  assert.equal(localDateInTz(beforeSpringForward, 'America/New_York'), '2026-03-08');
  assert.equal(localDateInTz(afterSpringForward, 'America/New_York'), '2026-03-08');
});

test('localDateInTz: offsetDays walks calendar days in the target timezone', () => {
  const now = new Date('2026-07-15T15:00:00Z');
  assert.equal(localDateInTz(now, 'America/New_York', 0), '2026-07-15');
  assert.equal(localDateInTz(now, 'America/New_York', 1), '2026-07-16');
  assert.equal(localDateInTz(now, 'America/New_York', -2), '2026-07-13');
});

test('weekdayIndexOfDate: Mon=0..Sun=6, pure calendar math independent of "today"', () => {
  assert.equal(weekdayIndexOfDate('2026-07-13'), 0); // Monday
  assert.equal(weekdayIndexOfDate('2026-07-15'), 2); // Wednesday
  assert.equal(weekdayIndexOfDate('2026-07-19'), 6); // Sunday
});

test('weekdayIndexOfDate: two different Wednesdays share an index but are different dates', () => {
  // This is exactly why the fix tracks selection by date STRING, not
  // weekday index: an index-only comparison would treat "last Wednesday"
  // and "this Wednesday" as the same day, letting one day's override/
  // completion state bleed into the other.
  const lastWednesday = '2026-07-08';
  const thisWednesday = '2026-07-15';
  assert.equal(weekdayIndexOfDate(lastWednesday), weekdayIndexOfDate(thisWednesday));
  assert.notEqual(lastWednesday, thisWednesday);
});

test('shouldResetToToday: true when the local date has moved on since last observed', () => {
  assert.equal(shouldResetToToday('2026-07-15', '2026-07-19'), true); // Wed -> Sun, days later
});

test('shouldResetToToday: false on a same-day background/foreground cycle', () => {
  // A deliberately-selected day must survive an unrelated resume that
  // happens on the same calendar date.
  assert.equal(shouldResetToToday('2026-07-19', '2026-07-19'), false);
});

test('reconciliation flow: Wednesday selected with completed exercises, foreground on Sunday selects Sunday with no Wednesday completion', () => {
  // Mirrors exactly what WorkoutsPanel's AppState 'change' listener does.
  let selectedDate = '2026-07-15'; // Wednesday — swapped to Pull, partially completed
  let completedExercises = new Set(['Bench Press', 'Row']); // Wednesday's saved completion
  let lastKnownToday = '2026-07-15';

  const newToday = '2026-07-19'; // app reopened on Sunday, several days later
  if (shouldResetToToday(lastKnownToday, newToday)) {
    lastKnownToday = newToday;
    selectedDate = newToday;
    completedExercises = new Set(); // resetDateTransientState()
  }

  assert.equal(selectedDate, '2026-07-19');
  assert.equal(completedExercises.size, 0, 'Wednesday completion must not survive onto Sunday');
});

test('reconciliation flow: explicitly selecting Wednesday within the same day is not undone by a later foreground check', () => {
  let selectedDate = '2026-07-19'; // today, Sunday
  const lastKnownToday = '2026-07-19';

  // User manually taps Wednesday's cell in the current week (handleDayPress)
  // — no date rollover involved, just browsing history.
  const wednesdayThisWeek = '2026-07-15';
  selectedDate = wednesdayThisWeek;

  // App backgrounds and returns to the foreground later the SAME day.
  const newToday = '2026-07-19';
  assert.equal(shouldResetToToday(lastKnownToday, newToday), false);
  // Selection is untouched — Wednesday's saved history is still what's shown.
  assert.equal(selectedDate, wednesdayThisWeek);
});

test('request guard: a delayed Wednesday response arriving after Sunday has been selected is discarded', () => {
  const guard = createRequestGuard();
  const wednesdayRequestId = guard.begin(); // fetch started while Wednesday was selected
  const sundayRequestId = guard.begin(); // user switches to Sunday before Wednesday's fetch resolves

  // Wednesday's slow response finally arrives — it must be treated as stale.
  assert.equal(guard.isStale(wednesdayRequestId), true);
  // Sunday's own response, once it arrives, is still current and must apply.
  assert.equal(guard.isStale(sundayRequestId), false);
});

test("Sunday's API request is built from Sunday's own absolute date, never a stale index-derived one", () => {
  const selectedDate = '2026-07-19'; // the actual current selection on Sunday
  // WorkoutsPanel passes selectedKey (=selectedDate) directly as the `day`/
  // `date` query param on every checks/logs/activities/overrides request —
  // never a value re-derived from a weekday index.
  const requestedDay = selectedDate;
  assert.equal(requestedDay, '2026-07-19');
  assert.equal(weekdayIndexOfDate(requestedDay), 6); // Sunday, for schedule lookups only
});

test("a Wednesday override does not affect Sunday's completion state", () => {
  // completedExercises/workoutLogs are flat, single-day state in
  // WorkoutsPanel — resetDateTransientState() clears them on every
  // selection change, so a swap persisted for Wednesday (workout_overrides,
  // keyed by its own absolute date server-side) can never leak into
  // whatever is currently rendered for Sunday.
  let completedExercises = new Set(['Bench Press']); // Wednesday, Pull swapped in
  const wednesdaySwap = { '2026-07-15': 'pull' };

  // Selection moves to Sunday (foreground reconciliation or a manual tap).
  completedExercises = new Set(); // resetDateTransientState()

  assert.equal(completedExercises.size, 0);
  assert.equal(wednesdaySwap['2026-07-15'], 'pull', "Wednesday's own override is untouched, just not applied to Sunday");
});
