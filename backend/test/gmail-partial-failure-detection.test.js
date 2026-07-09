// Individual thread-fetch failures inside fetchGmailThreads' Promise.all were
// caught per-thread and converted to null (then filtered out) with only a
// console.error — indistinguishable from a thread that legitimately had zero
// messages. A partial failure should still just quietly report fewer threads
// (that's an acceptable degrade), but if EVERY unread thread fails to fetch,
// that's a real outage and must be visible, not silently read as "zero
// unread email." Same "200 OK read as success" bug class already fixed for
// Monarch/Calendar/Notion/Eight Sleep.
const test = require('node:test');
const assert = require('node:assert/strict');
const { google } = require('googleapis');

process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REFRESH_TOKEN = 'test-refresh-token';

const { fetchGmailThreads } = require('../src/services/gmail');

function fakeThread(id, ok) {
  return {
    id,
    async get() {
      if (!ok) throw new Error(`simulated failure for ${id}`);
      return {
        data: {
          messages: [{
            snippet: 'hi',
            payload: { headers: [{ name: 'From', value: 'a@b.com' }, { name: 'Subject', value: 'Hey' }], body: {} },
          }],
        },
      };
    },
  };
}

test('fetchGmailThreads throws when every unread thread fails to fetch', async () => {
  google.gmail = () => ({
    users: {
      threads: {
        list: async () => ({ data: { threads: [{ id: 't1' }, { id: 't2' }] } }),
        get: async ({ id }) => fakeThread(id, false).get(),
      },
    },
  });
  await assert.rejects(() => fetchGmailThreads(), /all 2 unread thread\(s\) failed/);
});

test('fetchGmailThreads returns the successful threads when only some fail (partial degrade, no throw)', async () => {
  google.gmail = () => ({
    users: {
      threads: {
        list: async () => ({ data: { threads: [{ id: 't1' }, { id: 't2' }] } }),
        get: async ({ id }) => fakeThread(id, id === 't1').get(),
      },
    },
  });
  const result = await fetchGmailThreads();
  assert.equal(result.length, 1);
});

test('fetchGmailThreads returns [] when there are no unread threads (legitimate empty, not an error)', async () => {
  google.gmail = () => ({
    users: {
      threads: {
        list: async () => ({ data: { threads: [] } }),
        get: async () => { throw new Error('should not be called'); },
      },
    },
  });
  const result = await fetchGmailThreads();
  assert.deepEqual(result, []);
});
