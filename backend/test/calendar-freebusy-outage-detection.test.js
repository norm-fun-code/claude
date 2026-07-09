// Google's freebusy.query API returns HTTP 200 for the overall request even
// when a SPECIFIC calendar failed (revoked share, transient Google-side
// error) — the failure is embedded in calendars[calId].errors, not a thrown
// error. Before this fix, fetchWorkBusyBlocks read only `.busy` and silently
// returned [] on that shape, indistinguishable from a genuinely meeting-free
// day — the exact "200 OK read as success" bug already fixed for Monarch's
// MCP sync (see monarch-mcp-outage-detection.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { google } = require('googleapis');

process.env.GOOGLE_WORK_CALENDAR_ID = 'work@example.com';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REFRESH_TOKEN = 'test-refresh-token';

const { fetchWorkBusyBlocks } = require('../src/services/calendar');

test('fetchWorkBusyBlocks throws when Google embeds a per-calendar error in a 200 response', async () => {
  google.calendar = () => ({
    freebusy: {
      query: async () => ({
        data: {
          calendars: {
            'work@example.com': { errors: [{ domain: 'global', reason: 'notFound' }] },
          },
        },
      }),
    },
  });
  await assert.rejects(() => fetchWorkBusyBlocks(), /notFound/);
});

test('fetchWorkBusyBlocks returns busy blocks normally when there is no embedded error', async () => {
  google.calendar = () => ({
    freebusy: {
      query: async () => ({
        data: {
          calendars: {
            'work@example.com': {
              busy: [{ start: '2026-07-09T14:00:00Z', end: '2026-07-09T15:00:00Z' }],
            },
          },
        },
      }),
    },
  });
  const blocks = await fetchWorkBusyBlocks({ date: new Date('2026-07-09T12:00:00Z') });
  assert.equal(blocks.length, 1);
});

test('fetchWorkBusyBlocks returns [] when GOOGLE_WORK_CALENDAR_ID is unset (no API call at all)', async () => {
  const prior = process.env.GOOGLE_WORK_CALENDAR_ID;
  delete process.env.GOOGLE_WORK_CALENDAR_ID;
  try {
    const blocks = await fetchWorkBusyBlocks();
    assert.deepEqual(blocks, []);
  } finally {
    process.env.GOOGLE_WORK_CALENDAR_ID = prior;
  }
});
