const test = require('node:test');
const assert = require('node:assert/strict');
const { hasDisplayableBriefToday, hasPublishableFreshBriefToday } = require('../src/notify/morning');

const TZ = 'America/New_York';

// Bug: BRIEFING_FRESH_SKIP_MS's rolling 2-hour window meant an 8:03am manual
// build stopped suppressing the automatic trigger by 10:03am — an 11:33am
// scheduler/cron/watcher/Eight-Sleep run would rebuild AND re-announce "Good
// morning" a second time. hasDisplayableBriefToday()/hasPublishableFreshBriefToday()
// replace the rolling window with local-calendar-day semantics: ANY valid
// build from earlier today suppresses every later automatic trigger for the
// rest of that day, however many hours have passed — but only a FRESH build
// (brain/claimValidator.js's assessChiefBriefQuality) is allowed to actually
// suppress the automatic routine; see the dedicated hasPublishableFreshBriefToday
// tests below for the degraded-brief distinction.

test('a manual build at 8:03 AM EDT still suppresses an automatic trigger at 11:33 AM EDT the same day', () => {
  const manualBuildAt = new Date('2026-07-14T12:03:00.000Z'); // 8:03 AM EDT
  const automaticCheckAt = new Date('2026-07-14T15:33:00.000Z'); // 11:33 AM EDT — 5.5h later
  const latest = { generated_at: manualBuildAt.toISOString(), content: { chiefBrief: { synthesis: 's' } } };
  assert.equal(
    hasDisplayableBriefToday(latest, { now: automaticCheckAt, tz: TZ }),
    true,
    'a same-local-day build must suppress the automatic trigger no matter how many hours have passed'
  );
});

test('a build from a PRIOR day does not suppress today\'s automatic trigger', () => {
  const yesterdayBuild = new Date('2026-07-13T12:03:00.000Z'); // 8:03 AM EDT, the day before
  const todayCheck = new Date('2026-07-14T12:30:00.000Z'); // 8:30 AM EDT the next day
  const latest = { generated_at: yesterdayBuild.toISOString(), content: { chiefBrief: { synthesis: 's' } } };
  assert.equal(hasDisplayableBriefToday(latest, { now: todayCheck, tz: TZ }), false);
});

test('a failed/incomplete manual build (no chiefBrief at all) does not suppress the scheduled build', () => {
  const manualBuildAt = new Date('2026-07-14T12:03:00.000Z');
  const automaticCheckAt = new Date('2026-07-14T15:33:00.000Z');
  const latest = { generated_at: manualBuildAt.toISOString(), content: { chiefBrief: null } };
  assert.equal(
    hasDisplayableBriefToday(latest, { now: automaticCheckAt, tz: TZ }),
    false,
    'a genuinely broken build (no fresh AND no carried-forward chiefBrief) must not block the scheduled build'
  );
});

test('a build that fell back to a carried-forward chiefBrief (chiefBriefStale) still counts as displayable', () => {
  // buildFreshBriefing carries the PRIOR build's chiefBrief forward when this
  // build's own LLM call failed — the user still sees a real, displayable
  // brief, just not freshly generated. That's not the same as a totally
  // empty build.
  const manualBuildAt = new Date('2026-07-14T12:03:00.000Z');
  const automaticCheckAt = new Date('2026-07-14T15:33:00.000Z');
  const latest = { generated_at: manualBuildAt.toISOString(), content: { chiefBrief: { synthesis: 'carried forward' }, chiefBriefStale: true } };
  assert.equal(hasDisplayableBriefToday(latest, { now: automaticCheckAt, tz: TZ }), true);
});

test('no prior brief at all → never suppress', () => {
  assert.equal(hasDisplayableBriefToday(null, { now: new Date(), tz: TZ }), false);
  assert.equal(hasDisplayableBriefToday(undefined, { now: new Date(), tz: TZ }), false);
});

test('a garbage timestamp is treated as not-built-today (fail open, build the brief)', () => {
  assert.equal(hasDisplayableBriefToday({ generated_at: 'not-a-date', content: { chiefBrief: {} } }, { now: new Date(), tz: TZ }), false);
});

test('right at local midnight, a build from 1 minute before does not count as today', () => {
  // 11:59 PM EDT July 13 vs "now" = 12:01 AM EDT July 14 — different local days.
  const justBeforeMidnight = new Date('2026-07-14T03:59:00.000Z'); // 11:59 PM EDT Jul 13
  const justAfterMidnight = new Date('2026-07-14T04:01:00.000Z'); // 12:01 AM EDT Jul 14
  const latest = { generated_at: justBeforeMidnight.toISOString(), content: { chiefBrief: { synthesis: 's' } } };
  assert.equal(hasDisplayableBriefToday(latest, { now: justAfterMidnight, tz: TZ }), false);
});

test('a build from earlier the SAME local day, close to midnight, still counts', () => {
  const earlyThisMorning = new Date('2026-07-14T04:05:00.000Z'); // 12:05 AM EDT Jul 14
  const laterSameDay = new Date('2026-07-14T15:33:00.000Z'); // 11:33 AM EDT Jul 14
  const latest = { generated_at: earlyThisMorning.toISOString(), content: { chiefBrief: { synthesis: 's' } } };
  assert.equal(hasDisplayableBriefToday(latest, { now: laterSameDay, tz: TZ }), true);
});

// ── hasPublishableFreshBriefToday — the quality-aware bar ───────────────────
// A displayable brief is not necessarily a GOOD one: the audit-fix bug was a
// degraded automatic build (an exact claim-validator grounded-fallback
// sentence, e.g. "Recovery is green at 100 today.") being treated as a
// successful morning build, permanently burning the once-a-day slot so no
// later automatic retry ever ran.

test('a FRESH-quality build counts as publishable', () => {
  const at = new Date('2026-07-14T12:03:00.000Z');
  const latest = {
    generated_at: at.toISOString(),
    content: { chiefBrief: { synthesis: 'A real, detailed synthesis of the morning.' }, chiefBriefQuality: { status: 'fresh' } },
  };
  assert.equal(hasPublishableFreshBriefToday(latest, { now: at, tz: TZ }), true);
});

test('a DEGRADED build (grounded-fallback / underfilled) does NOT count as publishable, even though it is displayable', () => {
  const at = new Date('2026-07-14T12:03:00.000Z');
  const latest = {
    generated_at: at.toISOString(),
    content: {
      chiefBrief: { synthesis: 'Recovery is green at 100 today.' },
      chiefBriefQuality: { status: 'degraded', reasonCodes: ['grounded_fallback_used'], fallbackFields: ['synthesis'] },
    },
  };
  assert.equal(hasDisplayableBriefToday(latest, { now: at, tz: TZ }), true, 'still has something to show');
  assert.equal(hasPublishableFreshBriefToday(latest, { now: at, tz: TZ }), false, 'must not count as a successful fresh morning build');
});

test('a FAILED build does NOT count as publishable', () => {
  const at = new Date('2026-07-14T12:03:00.000Z');
  const latest = {
    generated_at: at.toISOString(),
    content: { chiefBrief: { synthesis: 'x' }, chiefBriefQuality: { status: 'failed', reasonCodes: ['no_chief_brief'] } },
  };
  assert.equal(hasPublishableFreshBriefToday(latest, { now: at, tz: TZ }), false);
});

test('a build with NO chiefBriefQuality metadata (predates the contract) is treated as fresh, for backward compatibility', () => {
  const at = new Date('2026-07-14T12:03:00.000Z');
  const latest = { generated_at: at.toISOString(), content: { chiefBrief: { synthesis: 's' } } };
  assert.equal(hasPublishableFreshBriefToday(latest, { now: at, tz: TZ }), true);
});

test('a totally empty build is never publishable, quality metadata or not', () => {
  const at = new Date('2026-07-14T12:03:00.000Z');
  const latest = { generated_at: at.toISOString(), content: { chiefBrief: null, chiefBriefQuality: { status: 'failed' } } };
  assert.equal(hasPublishableFreshBriefToday(latest, { now: at, tz: TZ }), false);
});
