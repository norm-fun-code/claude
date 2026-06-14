// Read-only Eight Sleep API probe. Authenticates with your Eight Sleep account
// and prints last night's session so we can see EXACTLY what data is available
// before building the auto-sync. Reads credentials from the environment ONLY —
// never hardcode or commit them:
//
//   EIGHT_SLEEP_EMAIL=you@example.com EIGHT_SLEEP_PASSWORD='...' \
//     node backend/scripts/eight-sleep-probe.js
//
// Nothing is written to disk or sent anywhere except Eight Sleep's own API.

const AUTH_URL = 'https://auth-api.8slp.net/v1/tokens';
const CLIENT_API_URL = 'https://client-api.8slp.net/v1';
// The Eight Sleep app's own OAuth2 client credentials — public, reverse-engineered
// values used by every community integration (pyEight, Home Assistant). NOT secrets,
// NOT your account: they only identify "the Eight Sleep app" to the token endpoint.
const KNOWN_CLIENT_ID = '0894c7f33bb94800a03f1f4df13a4f38';
const KNOWN_CLIENT_SECRET = 'f0954a3ed5763ba3d06834c73731a32f15f168f47d4f164751275def86db0c76';

const HEADERS = {
  'content-type': 'application/json',
  'user-agent': 'okhttp/4.9.3',
  accept: 'application/json',
};

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const email = process.env.EIGHT_SLEEP_EMAIL;
  const password = process.env.EIGHT_SLEEP_PASSWORD;
  if (!email || !password) {
    console.error('Set EIGHT_SLEEP_EMAIL and EIGHT_SLEEP_PASSWORD in the environment.');
    process.exit(1);
  }

  // 1) Authenticate → bearer token + userId
  console.log('→ Authenticating with Eight Sleep…');
  const authRes = await fetch(AUTH_URL, {
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
  if (!authRes.ok) {
    console.error(`✗ Auth failed: ${authRes.status} ${authRes.statusText}`);
    console.error(await authRes.text());
    process.exit(1);
  }
  const auth = await authRes.json();
  const token = auth.access_token;
  let userId = auth.userId;
  console.log(`✓ Authenticated. userId=${userId ?? '(not in token, will fetch)'}\n`);

  const authedHeaders = { ...HEADERS, authorization: `Bearer ${token}` };

  // 2) Fallback: resolve userId from /users/me if the token didn't include it
  if (!userId) {
    const meRes = await fetch(`${CLIENT_API_URL}/users/me`, { headers: authedHeaders });
    const me = await meRes.json();
    userId = me?.user?.userId || me?.userId;
    console.log(`✓ Resolved userId=${userId}\n`);
  }

  // 3) Fetch the last 5 days of trends (sleep sessions)
  const to = new Date();
  const from = new Date(to.getTime() - 5 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    tz: process.env.TZ || 'America/New_York',
    from: fmtDate(from),
    to: fmtDate(to),
    'include-main': 'false',
    'include-all-sessions': 'true',
    'model-version': 'v2',
  });
  const trendsUrl = `${CLIENT_API_URL}/users/${userId}/trends?${params}`;
  console.log(`→ Fetching trends: ${trendsUrl}\n`);
  const trendsRes = await fetch(trendsUrl, { headers: authedHeaders });
  if (!trendsRes.ok) {
    console.error(`✗ Trends fetch failed: ${trendsRes.status} ${trendsRes.statusText}`);
    console.error(await trendsRes.text());
    process.exit(1);
  }
  const trends = await trendsRes.json();
  const days = trends?.days || [];
  console.log(`✓ Got ${days.length} day(s) of data.\n`);

  if (!days.length) {
    console.log('No sleep sessions in the window. Full payload:');
    console.log(JSON.stringify(trends, null, 2).slice(0, 4000));
    return;
  }

  // 4) Show the most recent night in full so we see every available field
  const latest = days[days.length - 1];
  console.log('═══ MOST RECENT NIGHT — RAW ═══');
  console.log(JSON.stringify(latest, null, 2));

  // 5) Quick extract of the fields we'd ingest
  const g = (obj, path) => path.reduce((o, k) => (o == null ? o : o[k]), obj);
  console.log('\n═══ EXTRACTED (what NormOS would ingest) ═══');
  console.log('date:           ', latest.day);
  console.log('sleep score:    ', latest.score);
  console.log('HRV:            ', g(latest, ['sleepQualityScore', 'hrv', 'current']));
  console.log('respiratory:    ', g(latest, ['sleepQualityScore', 'respiratoryRate', 'current']));
  console.log('light (s):      ', latest.lightDuration);
  console.log('deep (s):       ', latest.deepDuration);
  console.log('rem (s):        ', latest.remDuration);
  console.log('presence dur(s):', latest.presenceDuration);
  console.log('sleep dur (s):  ', latest.sleepDuration);
}

main().catch((e) => {
  console.error('Probe error:', e.message);
  process.exit(1);
});
