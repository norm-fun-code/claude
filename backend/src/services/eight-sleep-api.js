// Eight Sleep API client. Authenticates with your Eight Sleep account and pulls
// the nightly "trends" (sleep sessions) that carry HRV, resting HR, respiratory
// rate, sleep score, and sleep-stage durations.
//
// Endpoints + the app's public OAuth client id/secret are the same ones every
// community integration uses (pyEight, Home Assistant). The client id/secret are
// NOT account secrets — they only identify "the Eight Sleep app" to the token
// endpoint. YOUR credentials come from EIGHT_SLEEP_EMAIL / EIGHT_SLEEP_PASSWORD.
const AUTH_URL = 'https://auth-api.8slp.net/v1/tokens';
const CLIENT_API_URL = 'https://client-api.8slp.net/v1';
const KNOWN_CLIENT_ID = '0894c7f33bb94800a03f1f4df13a4f38';
const KNOWN_CLIENT_SECRET = 'f0954a3ed5763ba3d06834c73731a32f15f168f47d4f164751275def86db0c76';

const HEADERS = {
  'content-type': 'application/json',
  'user-agent': 'okhttp/4.9.3',
  accept: 'application/json',
};

/** Authenticate; returns { token, userId, expiresAt(ms epoch) }. Throws on failure. */
async function login(email, password) {
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      client_id: KNOWN_CLIENT_ID,
      client_secret: KNOWN_CLIENT_SECRET,
      grant_type: 'password',
      username: email,
      password,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Eight Sleep auth failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const expiresAt = json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : null;
  return { token: json.access_token, userId: json.userId ?? null, expiresAt };
}

/** Resolve the userId from /users/me when the token response didn't include it. */
async function resolveUserId(token) {
  const res = await fetch(`${CLIENT_API_URL}/users/me`, {
    headers: { ...HEADERS, authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Eight Sleep /users/me failed: ${res.status}`);
  const json = await res.json();
  return json?.user?.userId || json?.userId || null;
}

/** Pull daily sleep trends in [from, to] (YYYY-MM-DD). Returns the `days` array. */
async function getTrends({ token, userId, from, to, tz = 'America/New_York' }) {
  const params = new URLSearchParams({
    tz,
    from,
    to,
    'include-main': 'false',
    'include-all-sessions': 'true',
    'model-version': 'v2',
  });
  const res = await fetch(`${CLIENT_API_URL}/users/${userId}/trends?${params}`, {
    headers: { ...HEADERS, authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Eight Sleep trends failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return Array.isArray(json?.days) ? json.days : [];
}

/** Check if the user currently has an active (in-progress) sleep interval.
 *  Returns true if the session is still running, false if done or unknown.
 *  Eight Sleep returns 404 (or an interval with no endTs) when no session is active. */
async function getIntervalPresent(token, userId) {
  const res = await fetch(`${CLIENT_API_URL}/users/${userId}/intervals/present`, {
    headers: { ...HEADERS, authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return false;
  if (!res.ok) {
    const err = new Error(`Eight Sleep present failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return json?.interval != null;
}

module.exports = { login, resolveUserId, getTrends, getIntervalPresent };
