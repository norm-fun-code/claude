// Behavioral proof for item 2 ("consumers must use stateVersion/field
// versions to reject or refresh stale cached state") AND item 3 ("no post-cut
// mutation silently leaves the served brief wrong"), driven through the REAL
// production call path: a real full build cuts a snapshot and caches it; a
// REAL HTTP mutation (POST /api/workout/override, the exact route the mobile
// app calls) lands AFTER that cut; the very next cache-hit read must reflect
// it — not keep silently serving the pre-mutation workout/forecast.
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, authHeader, closeDb } = require('./helpers');
const db = require('../../src/db');
const { getEffectiveWorkout } = require('../../src/services/workout');

const app = buildTestApp();
const TZ = 'America/New_York';

function todayKey(tz = TZ) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

const WORKOUT_LABELS = { push: 'Push', pull: 'Pull', zone2: 'Zone 2', mobility: 'Mobility', intervals: 'Intervals', rest: 'Rest' };

test.after(async () => {
  await db.query('DELETE FROM workout_overrides WHERE log_date = $1', [todayKey()]);
  await closeDb();
});

test('a workout-override mutation after a full build changes the NEXT cache-hit read, not just a future full rebuild', async () => {
  const { buildFreshBriefing } = require('../../src/routes/briefing');

  // Clean slate for today.
  await db.query('DELETE FROM workout_overrides WHERE log_date = $1', [todayKey()]);

  // 1) A real full build — cuts a snapshot, persists it, stamps fieldVersions.
  const first = await buildFreshBriefing({ force: true });
  assert.notEqual(first.cached, true);
  const beforeEff = await getEffectiveWorkout({ tz: TZ });

  // Pick an override id guaranteed to DIFFER from today's current effective
  // workout, so the assertion below can't pass by coincidence.
  const candidates = ['push', 'pull', 'zone2', 'mobility', 'intervals', 'rest'];
  const overrideId = candidates.find((id) => id !== beforeEff.workoutId) || 'rest';

  // 2) The REAL mutation — the exact HTTP route the mobile app posts to.
  const post = await request(app)
    .post('/api/workout/override')
    .set(authHeader())
    .send({ date: todayKey(), workoutId: overrideId });
  assert.equal(post.status, 200);

  // 3) The NEXT read (a cache-hit — a real brief already exists for today, so
  // force:false takes the cache-hit branch) must reflect the override, not
  // keep serving what the FIRST build cached before the mutation happened.
  const second = await buildFreshBriefing({ force: false });
  assert.equal(second.cached, true, 'must be a cache-hit read, not a second full rebuild');
  assert.equal(second.workout?.type, WORKOUT_LABELS[overrideId],
    'the cache-hit response must carry the OVERRIDDEN workout, not the pre-mutation cached one');
  // And it must actually have MOVED from what the first build cached (proves
  // this isn't just coincidentally the same label).
  assert.notEqual(second.workout?.type, first.workout?.type,
    'the override changed the effective workout — the cached response must show a DIFFERENT label than the pre-mutation build');
});
