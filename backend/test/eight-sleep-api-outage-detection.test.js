// A 200 response with a malformed body (missing/non-array "days", or an
// interval-present body missing the "interval" key entirely) used to
// silently collapse into [] / false — read as "nothing new" / "no active
// session" instead of a real failure, and never triggered the existing
// 401-retry/re-login logic (which only fires on a thrown error). Same "200
// OK read as success" bug class already fixed for Monarch/Calendar/Notion.
const test = require('node:test');
const assert = require('node:assert/strict');
const { getTrends, getIntervalPresent } = require('../src/services/eight-sleep-api');

function stubFetch(status, body) {
  global.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

test('getTrends throws when the 200 response has no "days" array', async () => {
  stubFetch(200, { error: 'temporarily unavailable' });
  await assert.rejects(
    () => getTrends({ token: 't', userId: 'u', from: '2026-07-01', to: '2026-07-05' }),
    /unexpected shape/,
  );
});

test('getTrends returns [] normally for a legitimately empty range', async () => {
  stubFetch(200, { days: [] });
  const days = await getTrends({ token: 't', userId: 'u', from: '2026-07-01', to: '2026-07-05' });
  assert.deepEqual(days, []);
});

test('getTrends returns real data when present', async () => {
  stubFetch(200, { days: [{ day: '2026-07-01' }] });
  const days = await getTrends({ token: 't', userId: 'u', from: '2026-07-01', to: '2026-07-05' });
  assert.equal(days.length, 1);
});

test('getIntervalPresent throws when the 200 response has no "interval" key at all', async () => {
  stubFetch(200, { unexpected: true });
  await assert.rejects(() => getIntervalPresent('t', 'u'), /unexpected shape/);
});

test('getIntervalPresent returns false for a legitimate {interval: null} (no active session)', async () => {
  stubFetch(200, { interval: null });
  assert.equal(await getIntervalPresent('t', 'u'), false);
});

test('getIntervalPresent returns true when an interval is present', async () => {
  stubFetch(200, { interval: { id: 'abc' } });
  assert.equal(await getIntervalPresent('t', 'u'), true);
});

test('getIntervalPresent returns false on a 404 (no session active) without throwing', async () => {
  stubFetch(404, {});
  assert.equal(await getIntervalPresent('t', 'u'), false);
});
