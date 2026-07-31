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
const { fetchWithTimeout } = require('../util/async');

const HEADERS = {
  'content-type': 'application/json',
  'user-agent': 'okhttp/4.9.3',
  accept: 'application/json',
};

// The morning readiness gate and final ingest both depend on this API. A
// hanging socket used to hold the job indefinitely, which looked in the app
// exactly like a rebuild that spun forever. Keep the deadline finite so the
// caller can fail closed, record the real reason, and retry on its next poll.
function requestTimeoutMs() {
  return Math.max(1_000, Number(process.env.EIGHT_SLEEP_API_TIMEOUT_MS) || 15_000);
}

/** Authenticate; returns { token, userId, expiresAt(ms epoch) }. Throws on failure. */
async function login(email, password) {
  const res = await fetchWithTimeout(AUTH_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      client_id: KNOWN_CLIENT_ID,
      client_secret: KNOWN_CLIENT_SECRET,
      grant_type: 'password',
      username: email,
      password,
    }),
  }, requestTimeoutMs(), 'Eight Sleep auth');
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
  const res = await fetchWithTimeout(`${CLIENT_API_URL}/users/me`, {
    headers: { ...HEADERS, authorization: `Bearer ${token}` },
  }, requestTimeoutMs(), 'Eight Sleep user lookup');
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
  const res = await fetchWithTimeout(`${CLIENT_API_URL}/users/${userId}/trends?${params}`, {
    headers: { ...HEADERS, authorization: `Bearer ${token}` },
  }, requestTimeoutMs(), 'Eight Sleep trends');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Eight Sleep trends failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  // A 200 with a malformed body (missing/non-array "days") is a real failure,
  // not "zero sessions this window" — collapsing it to [] silently read as
  // "nothing new" instead of surfacing the outage, and never triggered the
  // caller's 401-retry/re-login logic (which only fires on a thrown error).
  // A legitimately empty range (real {days: []}) still passes through fine.
  if (!Array.isArray(json?.days)) {
    throw new Error(`Eight Sleep trends returned an unexpected shape: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.days;
}

/** Check if the user currently has an active (in-progress) sleep interval.
 *  Returns true if the session is still running, false if done or unknown.
 *  Eight Sleep returns 404 (or an interval with no endTs) when no session is active. */
async function getIntervalPresent(token, userId) {
  const res = await fetchWithTimeout(`${CLIENT_API_URL}/users/${userId}/intervals/present`, {
    headers: { ...HEADERS, authorization: `Bearer ${token}` },
  }, requestTimeoutMs(), 'Eight Sleep presence');
  if (res.status === 404) return false;
  if (!res.ok) {
    const err = new Error(`Eight Sleep present failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  // A malformed/empty-object body (no "interval" key at all) is a real
  // failure, not "no active session" — the legitimate no-session shape is
  // {interval: null}, which still correctly returns false below. Throwing
  // here lets scheduler.js's fail-safe catch (assume still sleeping) handle
  // it, instead of silently reading garbage as "session ended."
  if (json == null || typeof json !== 'object' || !('interval' in json)) {
    throw new Error(`Eight Sleep present returned an unexpected shape: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.interval != null;
}

/**
 * Retrieve a valid Eight Sleep token from the cached source config, re-logging
 * if expired. Returns null if credentials aren't configured. Lives here (the
 * service layer) rather than in scheduler.js so BOTH the scheduler and the
 * sleep-readiness gate can share one auth path without a circular require.
 * Fails by THROWING on a login/network error — a caller that must "fail closed"
 * (the readiness gate) needs to distinguish "not configured" (null) from
 * "couldn't confirm" (throw), and silently swallowing the error here would
 * collapse those two very different cases into one.
 */
async function getCreds() {
  const email = process.env.EIGHT_SLEEP_EMAIL;
  const password = process.env.EIGHT_SLEEP_PASSWORD;
  if (!email || !password) return null;
  const { getSource, updateConfig } = require('../store/sources');
  const source = await getSource('eight_sleep_api');
  const cfg = source?.config ?? {};
  if (cfg.eightToken && cfg.eightUserId && cfg.eightTokenExpiresAt && Date.now() < cfg.eightTokenExpiresAt - 60_000) {
    return { token: cfg.eightToken, userId: cfg.eightUserId };
  }
  const auth = await login(email, password);
  let userId = auth.userId || cfg.eightUserId || null;
  if (!userId) userId = await resolveUserId(auth.token);
  await updateConfig('eight_sleep_api', {
    ...cfg,
    eightToken: auth.token,
    eightUserId: userId,
    eightTokenExpiresAt: auth.expiresAt,
  });
  return { token: auth.token, userId };
}

module.exports = { login, resolveUserId, getTrends, getIntervalPresent, getCreds };
