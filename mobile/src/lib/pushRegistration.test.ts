import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgePushRegistration,
  isCurrentPushRegistrationAck,
  PUSH_REGISTRATION_ACK_KEY,
  PUSH_REGISTRATION_ACK_TTL_MS,
} from './pushRegistration.ts';

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    get value() { return value; },
    getItem: async () => value,
    setItem: async (_key: string, next: string) => { value = next; },
  };
}

test('required: a 500 response never acknowledges registration, then a later retry can succeed', async () => {
  const storage = memoryStorage();
  let attempts = 0;
  const post = async () => ({ ok: ++attempts > 1 });

  assert.equal(await acknowledgePushRegistration({ pushToken: 'ExponentPushToken[token]', storage, post, now: 1000 }), 'notAcknowledged');
  assert.equal(storage.value, null, 'the failed response must not poison the retry state');

  assert.equal(await acknowledgePushRegistration({ pushToken: 'ExponentPushToken[token]', storage, post, now: 2000 }), 'acknowledged');
  assert.equal(attempts, 2);
  assert.match(storage.value ?? '', /ExponentPushToken\[token\]/);
});

test('required: a timed-out or rejected request remains retryable and writes no acknowledgement', async () => {
  const storage = memoryStorage();
  await assert.rejects(
    acknowledgePushRegistration({
      pushToken: 'ExponentPushToken[token]',
      storage,
      post: async () => { throw new Error('deadline exceeded'); },
      now: 1000,
    })
  );
  assert.equal(storage.value, null);

  assert.equal(await acknowledgePushRegistration({
    pushToken: 'ExponentPushToken[token]', storage, post: async () => ({ ok: true }), now: 2000,
  }), 'acknowledged');
});

test('a confirmed same-token acknowledgement suppresses duplicate posts only during its bounded TTL', async () => {
  const raw = JSON.stringify({ token: 'ExponentPushToken[token]', acknowledgedAt: 10_000 });
  const storage = memoryStorage(raw);
  let posts = 0;

  assert.equal(await acknowledgePushRegistration({
    pushToken: 'ExponentPushToken[token]', storage, post: async () => ({ ok: Boolean(++posts) }), now: 10_001,
  }), 'alreadyAcknowledged');
  assert.equal(posts, 0);
  assert.equal(isCurrentPushRegistrationAck(raw, 'ExponentPushToken[token]', 10_000 + PUSH_REGISTRATION_ACK_TTL_MS), false);
});

test('only an HTTP 2xx acknowledgement is persisted', async () => {
  const storage = memoryStorage();
  assert.equal(await acknowledgePushRegistration({
    pushToken: 'ExponentPushToken[token]', storage, post: async () => ({ ok: false }), now: 10_000,
  }), 'notAcknowledged');
  assert.equal(storage.value, null);
  assert.notEqual(PUSH_REGISTRATION_ACK_KEY, '');
});
