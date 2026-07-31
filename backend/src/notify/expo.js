// Expo push delivery. Sends to Expo's push service, which relays to APNs/FCM.
// No secret key is needed for basic sends — the device's Expo push token is the
// credential. https://docs.expo.dev/push-notifications/sending-notifications/
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const CHUNK = 100; // Expo accepts up to 100 messages per request
const { fetchWithTimeout } = require('../util/async');

function pushTimeoutMs() {
  return Math.max(1_000, Number(process.env.EXPO_PUSH_TIMEOUT_MS) || 10_000);
}

function isExpoPushToken(t) {
  return typeof t === 'string' && /^ExponentPushToken\[.+\]$|^ExpoPushToken\[.+\]$/.test(t);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Send one notification to many tokens.
 * @returns {Promise<{ok: boolean, sent: number, tickets: Array, invalidTokens: string[]}>}
 */
async function sendPush(tokens, { title, body, data = {} }) {
  const valid = (tokens || []).filter(isExpoPushToken);
  if (valid.length === 0) return { ok: true, sent: 0, tickets: [], invalidTokens: [] };

  const tickets = [];
  const invalidTokens = [];

  for (const group of chunk(valid, CHUNK)) {
    const messages = group.map((to) => ({ to, title, body, data, sound: 'default' }));
    const res = await fetchWithTimeout(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    }, pushTimeoutMs(), 'Expo push');
    if (!res.ok) {
      throw new Error(`Expo push failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
    const json = await res.json();
    const data2 = json?.data ?? [];
    data2.forEach((ticket, i) => {
      tickets.push(ticket);
      // Expo flags a dead token so we can stop sending to it.
      if (ticket?.status === 'error' && ticket?.details?.error === 'DeviceNotRegistered') {
        invalidTokens.push(group[i]);
      }
    });
  }

  return { ok: true, sent: valid.length, tickets, invalidTokens };
}

module.exports = { sendPush, isExpoPushToken, pushTimeoutMs };
