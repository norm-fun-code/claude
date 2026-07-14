const test = require('node:test');
const assert = require('node:assert/strict');
const { builtToday } = require('../src/notify/morning');

const TZ = 'America/New_York';

// Bug: BRIEFING_FRESH_SKIP_MS's rolling 2-hour window meant an 8:03am manual
// build stopped suppressing the automatic trigger by 10:03am — an 11:33am
// scheduler/cron/watcher/Eight-Sleep run would rebuild AND re-announce "Good
// morning" a second time. builtToday() replaces the rolling window with
// local-calendar-day semantics: ANY valid build from earlier today suppresses
// every later automatic trigger for the rest of that day, however many hours
// have passed.

test('a manual build at 8:03 AM EDT still suppresses an automatic trigger at 11:33 AM EDT the same day', () => {
  const manualBuildAt = new Date('2026-07-14T12:03:00.000Z'); // 8:03 AM EDT
  const automaticCheckAt = new Date('2026-07-14T15:33:00.000Z'); // 11:33 AM EDT — 5.5h later
  const latest = { generated_at: manualBuildAt.toISOString(), content: { chiefBrief: { synthesis: 's' } } };
  assert.equal(
    builtToday(latest, { now: automaticCheckAt, tz: TZ }),
    true,
    'a same-local-day build must suppress the automatic trigger no matter how many hours have passed'
  );
});

test('a build from a PRIOR day does not suppress today\'s automatic trigger', () => {
  const yesterdayBuild = new Date('2026-07-13T12:03:00.000Z'); // 8:03 AM EDT, the day before
  const todayCheck = new Date('2026-07-14T12:30:00.000Z'); // 8:30 AM EDT the next day
  const latest = { generated_at: yesterdayBuild.toISOString(), content: { chiefBrief: { synthesis: 's' } } };
  assert.equal(builtToday(latest, { now: todayCheck, tz: TZ }), false);
});

test('a failed/incomplete manual build (no chiefBrief at all) does not suppress the scheduled build', () => {
  const manualBuildAt = new Date('2026-07-14T12:03:00.000Z');
  const automaticCheckAt = new Date('2026-07-14T15:33:00.000Z');
  const latest = { generated_at: manualBuildAt.toISOString(), content: { chiefBrief: null } };
  assert.equal(
    builtToday(latest, { now: automaticCheckAt, tz: TZ }),
    false,
    'a genuinely broken build (no fresh AND no carried-forward chiefBrief) must not block the scheduled build'
  );
});

test('a build that fell back to a carried-forward chiefBrief (chiefBriefStale) still counts as valid', () => {
  // buildFreshBriefing carries the PRIOR build's chiefBrief forward when this
  // build's own LLM call failed — the user still sees a real, displayable
  // brief, just not freshly generated. That's not the same as a totally
  // empty build and must still suppress the automatic trigger.
  const manualBuildAt = new Date('2026-07-14T12:03:00.000Z');
  const automaticCheckAt = new Date('2026-07-14T15:33:00.000Z');
  const latest = { generated_at: manualBuildAt.toISOString(), content: { chiefBrief: { synthesis: 'carried forward' }, chiefBriefStale: true } };
  assert.equal(builtToday(latest, { now: automaticCheckAt, tz: TZ }), true);
});

test('no prior brief at all → never suppress', () => {
  assert.equal(builtToday(null, { now: new Date(), tz: TZ }), false);
  assert.equal(builtToday(undefined, { now: new Date(), tz: TZ }), false);
});

test('a garbage timestamp is treated as not-built-today (fail open, build the brief)', () => {
  assert.equal(builtToday({ generated_at: 'not-a-date', content: { chiefBrief: {} } }, { now: new Date(), tz: TZ }), false);
});

test('right at local midnight, a build from 1 minute before does not count as today', () => {
  // 11:59 PM EDT July 13 vs "now" = 12:01 AM EDT July 14 — different local days.
  const justBeforeMidnight = new Date('2026-07-14T03:59:00.000Z'); // 11:59 PM EDT Jul 13
  const justAfterMidnight = new Date('2026-07-14T04:01:00.000Z'); // 12:01 AM EDT Jul 14
  const latest = { generated_at: justBeforeMidnight.toISOString(), content: { chiefBrief: { synthesis: 's' } } };
  assert.equal(builtToday(latest, { now: justAfterMidnight, tz: TZ }), false);
});

test('a build from earlier the SAME local day, close to midnight, still counts', () => {
  const earlyThisMorning = new Date('2026-07-14T04:05:00.000Z'); // 12:05 AM EDT Jul 14
  const laterSameDay = new Date('2026-07-14T15:33:00.000Z'); // 11:33 AM EDT Jul 14
  const latest = { generated_at: earlyThisMorning.toISOString(), content: { chiefBrief: { synthesis: 's' } } };
  assert.equal(builtToday(latest, { now: laterSameDay, tz: TZ }), true);
});
