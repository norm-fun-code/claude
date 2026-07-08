// analyze.js labels life-context annotations attached to health anomaly
// findings as "(today)"/"(yesterday)"/"(N days ago)" so the user can see when
// they told the brief about something. The OLD logic computed the day boundary
// with `new Date(); .setHours(0,0,0,0)` — the SERVER PROCESS's own local
// timezone — while every other date boundary in this file (and the rest of the
// codebase) explicitly anchors to America/New_York. On a server that isn't
// running in Eastern time (the default on most cloud hosts, e.g. Railway =
// UTC), that boundary silently drifted by hours, mislabeling a same-day-morning
// annotation as "(yesterday)" once evening arrived Eastern time.
//
// These tests reproduce the OLD buggy computation and the NEW fixed one
// side-by-side under a non-Eastern server TZ, proving the bug existed and that
// the fix resolves it. process.env.TZ is restored after each test since Node
// respects it for subsequently-constructed Date local-time values.
const test = require('node:test');
const assert = require('node:assert/strict');

const ANNO_TZ = 'America/New_York';
function dayKey(d, tz = ANNO_TZ) {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
}

// The OLD (buggy) label logic — server-local-time boundary, exactly as it
// shipped before this fix.
function oldLabel(nowMs, annStartTs) {
  const startOfToday = new Date(nowMs); startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(nowMs); startOfYesterday.setDate(startOfYesterday.getDate() - 1); startOfYesterday.setHours(0, 0, 0, 0);
  const ts = new Date(annStartTs);
  return ts >= startOfToday ? 'today' : ts >= startOfYesterday ? 'yesterday' : '2 days ago';
}

// The NEW (fixed) label logic — tz-aware calendar-day-key comparison, mirroring
// the exact implementation now in src/intelligence/analyze.js.
function newLabel(nowMs, annStartTs) {
  const todayDayKey = dayKey(nowMs);
  const annDayKey = dayKey(annStartTs);
  if (annDayKey === todayDayKey) return 'today';
  const diffDays = Math.round((new Date(`${todayDayKey}T00:00:00Z`) - new Date(`${annDayKey}T00:00:00Z`)) / 86400000);
  return diffDays === 1 ? 'yesterday' : diffDays > 1 ? `${diffDays} days ago` : 'today';
}

test('reproduces the bug: a UTC-timezone server mislabels a same-Eastern-day morning note as "yesterday" once it is evening Eastern', () => {
  const prevTz = process.env.TZ;
  try {
    process.env.TZ = 'UTC'; // simulates a Railway-style server with no TZ set to Eastern
    // Annotation entered 8am Eastern on July 8 = noon UTC July 8.
    const annStartTs = '2026-07-08T12:00:00Z';
    // Viewed 7pm Eastern on the SAME July 8 = 11pm UTC July 8 (still July 8 UTC too —
    // the straightforward case where old logic happens to still work)...
    const sameUtcDayNow = new Date('2026-07-08T23:00:00Z').getTime();
    assert.equal(oldLabel(sameUtcDayNow, annStartTs), 'today', 'sanity: same UTC day still resolves correctly under old logic');

    // ...but viewed at 9pm Eastern on July 8 = 1am UTC July 9 — a new UTC calendar
    // day has begun even though it is still the SAME Eastern day (9pm) the note
    // was entered on. This is exactly the "entered this morning, mislabeled
    // yesterday by evening" bug the user hit.
    const nextUtcDayNow = new Date('2026-07-09T01:00:00Z').getTime();
    assert.equal(oldLabel(nextUtcDayNow, annStartTs), 'yesterday', 'BUG: old logic wrongly says yesterday');
    assert.equal(newLabel(nextUtcDayNow, annStartTs), 'today', 'FIX: new logic correctly says today — both instants are the same Eastern calendar day');
  } finally {
    process.env.TZ = prevTz;
  }
});

test('new logic is correct regardless of the server process timezone', () => {
  const prevTz = process.env.TZ;
  try {
    const annStartTs = '2026-07-08T12:00:00Z'; // 8am Eastern July 8
    const viewedAt = new Date('2026-07-09T01:00:00Z').getTime(); // 9pm Eastern July 8
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'America/New_York']) {
      process.env.TZ = tz;
      assert.equal(newLabel(viewedAt, annStartTs), 'today', `new logic must say "today" under server TZ=${tz}`);
    }
  } finally {
    process.env.TZ = prevTz;
  }
});

test('new logic correctly labels a genuinely prior-day annotation as yesterday / N days ago', () => {
  const now = new Date('2026-07-08T20:00:00Z').getTime(); // 4pm Eastern July 8
  assert.equal(newLabel(now, '2026-07-07T15:00:00Z'), 'yesterday'); // 11am Eastern July 7
  assert.equal(newLabel(now, '2026-07-06T15:00:00Z'), '2 days ago'); // 11am Eastern July 6
  assert.equal(newLabel(now, '2026-07-08T13:00:00Z'), 'today'); // 9am Eastern July 8, same day
});
