'use strict';
require('dotenv').config();
const crypto = require('crypto');

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET env var must be set in production');
  process.exit(1);
}

const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const db = require('./db');
const { run: runModel } = require('./public/model.js');

const ADVISOR_TOOLS = [
  {
    name: 'set_param',
    description: 'Propose changing one parameter in a sandbox copy of the plan. Never modifies anything until the user reviews the diff and explicitly applies it (to their live plan, a new scenario, or an existing one).',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Exact parameter key (e.g. homePrice, investReturn, startingLiquid, normTCY1)' },
        value: { type: 'number', description: 'New numeric value' },
        reason: { type: 'string', description: 'One sentence: why this change improves the plan' },
      },
      required: ['key', 'value', 'reason'],
    },
  },
  {
    name: 'run_projection',
    description: 'Run the financial projection with current sandbox parameters. Call this after set_param to measure impact.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'save_scenario',
    description: 'Propose saving the sandbox as a named scenario for the user to compare against their plan.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Short scenario name (e.g. "Lower home price")' } },
      required: ['name'],
    },
  },
];

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Middleware ──────────────────────────────────────────────────────────────
app.set('trust proxy', 1); // trust Railway's proxy for secure cookies
app.use(compression());
app.use(express.json({ limit: '2mb' }));

const sessionStore = new PgSession({
  pool: db.pool,
  createTableIfMissing: true,
});

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// The advisor endpoints proxy paid Anthropic API calls with a multi-turn tool-use loop —
// with a 30-day session cookie and no other throttle, a leaked/stolen session could run up
// unbounded API spend by looping requests. This doesn't rate-limit legitimate use (a human
// sending chat messages), just runaway/scripted request volume.
const advisorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many advisor requests — please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/login');
}

// Debug/introspection endpoints are off by default; set ENABLE_DEBUG_ENDPOINTS=1
// to expose them (they leak schema/host info and shouldn't run in production).
const DEBUG_ENDPOINTS = process.env.ENABLE_DEBUG_ENDPOINTS === '1';
function requireDebug(req, res, next) {
  if (!DEBUG_ENDPOINTS) return res.status(404).json({ error: 'Not found' });
  return requireAuth(req, res, next);
}

// ── Auth routes ─────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cohen Financial Planner — Sign In</title>
<meta name="theme-color" content="#635bff">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%237d76ff'/><stop offset='.55' stop-color='%235048d6'/><stop offset='1' stop-color='%237c3aed'/></linearGradient></defs><rect width='32' height='32' rx='7' fill='url(%23g)'/><path d='M6 21L13 14L17 18L26 8' stroke='%23fff' stroke-width='2.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/><circle cx='26' cy='8' r='2.4' fill='%23fff'/></svg>">
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#0a2540;padding:20px;-webkit-font-smoothing:antialiased;overflow:hidden}
.mesh{position:fixed;inset:-20%;z-index:-1;pointer-events:none;
  background:
    radial-gradient(38% 42% at 12% 4%, rgba(99,91,255,.20), transparent 62%),
    radial-gradient(34% 40% at 94% 8%, rgba(8,145,178,.16), transparent 60%),
    radial-gradient(40% 42% at 82% 96%, rgba(230,73,128,.12), transparent 62%),
    radial-gradient(42% 46% at 20% 100%, rgba(124,58,237,.14), transparent 64%),
    linear-gradient(180deg,#f7f9fd 0%,#eef2f9 100%);
  animation:drift 26s ease-in-out infinite alternate}
@keyframes drift{0%{transform:translate3d(0,0,0) scale(1)}100%{transform:translate3d(0,-2.4%,0) scale(1.06)}}
.card{background:rgba(255,255,255,.72);backdrop-filter:blur(22px) saturate(170%);-webkit-backdrop-filter:blur(22px) saturate(170%);
  border:1px solid rgba(255,255,255,.65);border-radius:18px;padding:36px 34px 32px;width:100%;max-width:392px;
  box-shadow:0 1px 1px rgba(10,37,64,.05),0 30px 60px -28px rgba(99,91,255,.5);
  animation:rise .6s cubic-bezier(.22,1,.36,1) both}
@keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
.brand{display:flex;align-items:center;gap:13px;margin-bottom:22px}
.mark{width:46px;height:46px;border-radius:13px;flex-shrink:0;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,#7d76ff 0%,#5048d6 55%,#7c3aed 100%);
  box-shadow:0 8px 20px -5px rgba(80,72,214,.65),inset 0 1px 0 rgba(255,255,255,.35)}
.brand h1{font-size:18px;font-weight:800;letter-spacing:-.5px;line-height:1.05;
  background:linear-gradient(95deg,#0a2540,#5048d6);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.brand .sub{font-size:9.5px;font-weight:600;color:#8898aa;text-transform:uppercase;letter-spacing:1.3px;margin-top:3px}
p{color:#425466;font-size:13px;margin-bottom:22px;line-height:1.5}
label{display:block;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#8898aa;margin-bottom:7px}
input{width:100%;background:rgba(255,255,255,.6);border:1px solid #d0d7de;color:#0a2540;font-family:inherit;font-size:14px;padding:12px 14px;border-radius:10px;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:#635bff;box-shadow:0 0 0 3px rgba(99,91,255,.14)}
button{width:100%;background:linear-gradient(135deg,#6e66ff,#5048d6);color:#fff;border:none;padding:13px;border-radius:10px;cursor:pointer;font-weight:600;font-size:14px;font-family:inherit;margin-top:18px;box-shadow:0 8px 20px -6px rgba(80,72,214,.6);transition:transform .15s cubic-bezier(.22,1,.36,1),box-shadow .15s ease}
button:hover{transform:translateY(-1px);box-shadow:0 12px 26px -7px rgba(80,72,214,.7)}
button:active{transform:translateY(0)}
button:disabled{background:#adbdcc;cursor:not-allowed;box-shadow:none;transform:none}
.err{background:rgba(252,234,238,.85);border:1px solid rgba(205,61,100,.25);color:#cd3d64;padding:10px 12px;border-radius:8px;font-size:12px;margin-top:12px;display:none}
</style>
</head>
<body>
<div class="mesh"></div>
<div class="card">
  <div class="brand">
    <div class="mark" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 20 20" fill="none"><path d="M3 13.5 L7.5 9 L10.5 12 L17 4.5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="17" cy="4.5" r="1.7" fill="#fff"/></svg></div>
    <div><h1>Cohen Family</h1><div class="sub">Financial Planner</div></div>
  </div>
  <p>Sign in to access your family financial plan.</p>
  <label>Password</label>
  <input type="password" id="pw" placeholder="Enter password" autofocus>
  <button id="btn" onclick="login()">Sign in</button>
  <div class="err" id="err"></div>
</div>
<script>
document.getElementById('pw').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
async function login() {
  const pw = document.getElementById('pw').value;
  const btn = document.getElementById('btn');
  const err = document.getElementById('err');
  err.style.display = 'none';
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    if (res.ok) { window.location.href = '/'; return; }
    const d = await res.json().catch(() => ({}));
    err.textContent = d.error || 'Wrong password.';
    err.style.display = 'block';
  } catch(e) {
    err.textContent = 'Network error — please try again.';
    err.style.display = 'block';
  }
  btn.disabled = false; btn.textContent = 'Sign in';
}
</script>
</body>
</html>`);
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { password } = req.body;
  if (password === process.env.APP_PASSWORD) {
    // Regenerate the session ID on successful auth (session-fixation defense) — without
    // this, an attacker who got a victim to use a session ID they control before login
    // would inherit an authenticated session once the victim logs in, since express-session
    // otherwise keeps the same ID across the anonymous->authenticated transition.
    return req.session.regenerate((err) => {
      if (err) {
        console.error('Session regenerate error:', err);
        return res.status(500).json({ error: 'Login failed' });
      }
      req.session.authenticated = true;
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('Session save error:', saveErr);
          return res.status(500).json({ error: 'Login failed' });
        }
        res.json({ ok: true });
      });
    });
  }
  await new Promise(r => setTimeout(r, 500));
  res.status(401).json({ error: 'Wrong password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── Protected static files ────────────────────────────────────────────────────
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/model.js', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'model.js'));
});

// ── Planner state ─────────────────────────────────────────────────────────────
app.get('/api/planner-state', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT state FROM planner_state WHERE id = 1');
    res.json(result.rows[0] || { state: {} });
  } catch (err) {
    console.error('GET planner-state error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/planner-state', requireAuth, async (req, res) => {
  try {
    const { state } = req.body;
    await db.query(
      `INSERT INTO planner_state (id, state) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET state = $1, updated_at = NOW()`,
      [JSON.stringify(state)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT planner-state error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Scenarios ─────────────────────────────────────────────────────────────────
app.get('/api/scenarios', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM scenarios ORDER BY created_at ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('GET scenarios error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/scenarios', requireAuth, async (req, res) => {
  try {
    const { id, name, color, params, results } = req.body;
    await db.query(
      `INSERT INTO scenarios (id, name, color, params, results)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name=$2, color=$3, params=$4, results=$5, updated_at=NOW()`,
      [id, name, color, JSON.stringify(params), JSON.stringify(results)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST scenarios error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/scenarios/:id', requireAuth, async (req, res) => {
  try {
    const { name, color, params, results } = req.body;
    const updates = [];
    const vals = [];
    let i = 1;
    if (name !== undefined) { updates.push(`name=$${i++}`); vals.push(name); }
    if (color !== undefined) { updates.push(`color=$${i++}`); vals.push(color); }
    if (params !== undefined) { updates.push(`params=$${i++}`); vals.push(JSON.stringify(params)); }
    if (results !== undefined) { updates.push(`results=$${i++}`); vals.push(JSON.stringify(results)); }
    if (!updates.length) return res.json({ ok: true });
    updates.push(`updated_at=NOW()`);
    vals.push(req.params.id);
    await db.query(`UPDATE scenarios SET ${updates.join(',')} WHERE id=$${i}`, vals);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT scenario error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/scenarios/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM scenarios WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE scenario error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Debug ──────────────────────────────────────────────────────────────────
app.get('/api/debug/db', requireDebug, async (req, res) => {
  try {
    const [sc, pl, sn, cols] = await Promise.all([
      db.query('SELECT id, name, color, created_at FROM scenarios ORDER BY created_at'),
      db.query('SELECT id, updated_at FROM planner_state'),
      db.query('SELECT id, label, created_at FROM snapshots ORDER BY created_at'),
      db.query(`SELECT table_name, column_name, data_type
                FROM information_schema.columns
                WHERE table_schema='public' AND table_name IN ('scenarios','planner_state','snapshots','advisor_chats')
                ORDER BY table_name, ordinal_position`),
    ]);
    res.json({
      scenarios: sc.rows,
      planner_state_rows: pl.rowCount,
      snapshots: sn.rows,
      schema: cols.rows,
      db_url_host: (process.env.DATABASE_URL||'').replace(/:[^:@]*@/,':*****@'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Monarch OAuth2 + MCP ─────────────────────────────────────────────────────
const MONARCH_AUTH = 'https://api.monarch.com';
const MONARCH_MCP  = 'https://api.monarch.com/mcp';

const RETIREMENT_SUBTYPES = new Set([
  '401k','403b','457b','traditional_ira','roth_ira','roth401k',
  'sep_ira','simple_ira','pension','retirement','defined_benefit','defined_contribution',
]);

async function monarchOAuthRow() {
  const r = await db.query("SELECT data FROM oauth_tokens WHERE key='monarch'");
  return r.rows[0]?.data ?? null;
}

// Multiple requests (concurrent tabs, or the advisor endpoint fetching both a Monarch
// snapshot and its tool schema) can all see an expired cached token at once. Without
// dedup, each independently POSTs the same refresh_token — if Monarch rotates refresh
// tokens (single-use), the second call invalidates what the first call just received,
// silently breaking one of the two concurrent requests. Share one in-flight refresh.
let _refreshInFlight = null;

async function getMonarchAccessToken() {
  const stored = await monarchOAuthRow();
  if (!stored) return null;
  // Return cached access token if still valid (5-min buffer)
  if (stored.expires_at && Date.now() < stored.expires_at - 5 * 60 * 1000) {
    return stored.access_token;
  }
  // Try refresh_token
  if (!stored.refresh_token) return null;
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = (async () => {
    try {
      const r = await fetch(`${MONARCH_AUTH}/oauth/token/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: stored.refresh_token,
          client_id: stored.client_id,
          resource: MONARCH_MCP,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        // Only a definitive auth rejection (4xx — e.g. invalid_grant, revoked token) means
        // the refresh token itself is dead and reconnect is required. A 5xx or network
        // hiccup is transient — clearing tokens then would force a full re-authorization
        // for what might just be a momentary Monarch outage, so leave them in place to
        // retry on the next request.
        if (r.status >= 400 && r.status < 500) {
          await db.query("DELETE FROM oauth_tokens WHERE key='monarch'");
        } else {
          console.error('Monarch token refresh transient failure:', r.status);
        }
        return null;
      }
      const tokens = await r.json();
      const updated = {
        ...stored,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || stored.refresh_token,
        expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
      };
      await db.query(
        "INSERT INTO oauth_tokens(key,data) VALUES('monarch',$1) ON CONFLICT(key) DO UPDATE SET data=$1,updated_at=NOW()",
        [JSON.stringify(updated)]
      );
      return updated.access_token;
    } catch (e) {
      console.error('Monarch token refresh error:', e.message);
      return null;
    } finally {
      _refreshInFlight = null;
    }
  })();
  return _refreshInFlight;
}

function parseSSEorJSON(text) {
  // Streamable-HTTP MCP may return either a JSON body or an SSE stream.
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  // SSE: collect the last `data:` line that parses as JSON
  let result = null;
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (l.startsWith('data:')) {
      const payload = l.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { result = JSON.parse(payload); } catch { /* skip */ }
    }
  }
  if (result === null) throw new Error('No JSON found in MCP response');
  return result;
}

let _mcpSessionId = null;

async function callMonarchMCP(accessToken, method, params = {}) {
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (_mcpSessionId) headers['Mcp-Session-Id'] = _mcpSessionId;

  const r = await fetch(MONARCH_MCP, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  // Capture session id if the server assigns one
  const sid = r.headers.get('mcp-session-id');
  if (sid) _mcpSessionId = sid;

  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`MCP ${r.status}: ${body.slice(0, 200)}`);
  }
  const text = await r.text();
  return parseSSEorJSON(text);
}

// Start OAuth flow — registers client dynamically, redirects to Monarch auth page
app.get('/api/monarch-connect', requireAuth, async (req, res) => {
  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/api/monarch-callback`;

    // Get or register OAuth client (re-register if redirect URI changed)
    const clientRow = await db.query("SELECT data FROM oauth_tokens WHERE key='monarch_client'");
    const storedClient = clientRow.rows[0]?.data;
    let clientId = (storedClient && storedClient.redirect_uri === redirectUri) ? storedClient.client_id : null;
    if (!clientId) {
      const reg = await fetch(`${MONARCH_AUTH}/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Cohen Financial Planner',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: 'mcp:read',
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!reg.ok) throw new Error('Client registration failed: ' + reg.status);
      const regData = await reg.json();
      clientId = regData.client_id;
      await db.query(
        "INSERT INTO oauth_tokens(key,data) VALUES('monarch_client',$1) ON CONFLICT(key) DO UPDATE SET data=$1",
        [JSON.stringify({ client_id: clientId, redirect_uri: redirectUri })]
      );
    }

    // PKCE
    const codeVerifier  = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');

    req.session.monarchOAuth = { codeVerifier, state, clientId, redirectUri };

    const url = new URL(`${MONARCH_AUTH}/oauth/authorize/`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'mcp:read');
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('resource', MONARCH_MCP); // RFC 8707 — required per MCP OAuth spec

    res.redirect(url.toString());
  } catch (err) {
    console.error('Monarch connect error:', err);
    res.redirect('/?monarch_error=' + encodeURIComponent(err.message));
  }
});

// OAuth callback — exchanges code for tokens
app.get('/api/monarch-callback', requireAuth, async (req, res) => {
  const { code, state, error } = req.query;
  const oauthState = req.session.monarchOAuth;

  if (error)   return res.redirect('/?monarch_error=' + encodeURIComponent(error));
  if (!oauthState || state !== oauthState.state) return res.redirect('/?monarch_error=state_mismatch');
  if (!code)   return res.redirect('/?monarch_error=no_code');

  try {
    const r = await fetch(`${MONARCH_AUTH}/oauth/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: oauthState.redirectUri,
        client_id: oauthState.clientId,
        code_verifier: oauthState.codeVerifier,
        resource: MONARCH_MCP,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const err = await r.text();
      return res.redirect('/?monarch_error=' + encodeURIComponent('Token exchange failed: ' + err.slice(0, 100)));
    }
    const tokens = await r.json();
    await db.query(
      "INSERT INTO oauth_tokens(key,data) VALUES('monarch',$1) ON CONFLICT(key) DO UPDATE SET data=$1,updated_at=NOW()",
      [JSON.stringify({
        client_id: oauthState.clientId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
      })]
    );
    delete req.session.monarchOAuth;
    res.redirect('/?monarch_connected=1');
  } catch (err) {
    res.redirect('/?monarch_error=' + encodeURIComponent(err.message));
  }
});

// Check OAuth connection status
app.get('/api/monarch-status', requireAuth, async (req, res) => {
  const stored = await monarchOAuthRow();
  res.json({ connected: !!stored?.access_token });
});

// Disconnect Monarch
app.post('/api/monarch-disconnect', requireAuth, async (req, res) => {
  await db.query("DELETE FROM oauth_tokens WHERE key='monarch'");
  res.json({ ok: true });
});

// Debug: list available MCP tools + schemas
app.get('/api/monarch-tools', requireDebug, async (req, res) => {
  try {
    const accessToken = await getMonarchAccessToken();
    if (!accessToken) return res.status(401).json({ error: 'Not connected' });
    await monarchMCPHandshake(accessToken);
    const list = await callMonarchMCP(accessToken, 'tools/list');
    res.json(list?.result ?? list);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Probe: discover portfolio/holdings tools and try calling them
app.get('/api/monarch-probe-portfolio', requireDebug, async (req, res) => {
  try {
    const accessToken = await getMonarchAccessToken();
    if (!accessToken) return res.status(401).json({ error: 'Not connected' });
    await monarchMCPHandshake(accessToken);

    // 1. Get full tool list
    const list = await callMonarchMCP(accessToken, 'tools/list');
    const allTools = (list?.result?.tools ?? list?.tools ?? []).map(t => t.name ?? t);

    // 2. Try each likely portfolio tool name
    const candidates = [
      'GetPortfolio','GetAccountHoldings','GetHoldings','GetInvestments',
      'GetSecurities','GetPositions','GetInvestmentAccounts',
      'get_portfolio','get_account_holdings','get_holdings','get_investments',
    ];
    const results = {};
    for (const name of candidates) {
      if (!allTools.includes(name)) { results[name] = 'NOT_IN_TOOL_LIST'; continue; }
      try {
        const r = await callMonarchMCP(accessToken, 'tools/call', { name, arguments: {} });
        results[name] = { ok: true, preview: JSON.stringify(unwrapMCPResult(r)).slice(0, 500) };
      } catch(e) {
        results[name] = { ok: false, error: e.message };
      }
    }
    res.json({ allTools, results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Investment holdings from Monarch GetInvestments MCP tool
app.get('/api/monarch-investments', requireAuth, async (req, res) => {
  try {
    const accessToken = await getMonarchAccessToken();
    if (!accessToken) return res.status(401).json({ error: 'Monarch not connected', connectUrl: '/api/monarch-connect' });
    await monarchMCPHandshake(accessToken);

    const now = new Date();
    const end = req.query.end || now.toISOString().slice(0, 10);
    // YTD has no fixed day-count — handle it before the lookup so it can't fall through
    // to the `?? 30` default (periodDays['YTD'] is intentionally null, and `??` treats
    // null the same as "missing", which previously silently aliased YTD to 1M).
    const isYTD = req.query.period === 'YTD';
    const periodDays = { '1W': 7, '1M': 30, '3M': 90, '1Y': 365 };
    const pd = isYTD ? null : (periodDays[req.query.period] ?? 30);
    const start = req.query.start || (isYTD
      ? `${now.getFullYear()}-01-01`
      : new Date(now.getTime() - pd * 864e5).toISOString().slice(0, 10));

    const result = await callMonarchMCP(accessToken, 'tools/call', {
      name: 'GetInvestments',
      arguments: { start_date: start, end_date: end },
    });
    const data = unwrapMCPResult(result);
    if (!data) return res.status(502).json({ error: 'No data returned from GetInvestments' });

    const holdings = (data.investments || []).map(h => ({
      ticker: h.ticker || '—',
      value: Math.round(Number(h.value) || 0),
      securityType: h.security_type || 'other',
      periodChange: Math.round((Number(h.period_change_dollars) || 0) * 100) / 100,
      periodChangePct: Math.round((Number(h.period_change_percent) || 0) * 100) / 100,
      allTimeChange: Math.round((Number(h.variation_dollars) || 0) * 100) / 100,
      allTimePct: Math.round((Number(h.variation_percent) || 0) * 100) / 100,
    })).sort((a, b) => b.value - a.value);

    const totalValue = holdings.reduce((s, h) => s + h.value, 0);
    const periodChange = holdings.reduce((s, h) => s + h.periodChange, 0);
    const allTimeChange = holdings.reduce((s, h) => s + h.allTimeChange, 0);
    const priorValue = totalValue - periodChange;
    const withMoves = holdings.filter(h => h.securityType !== 'cash' && h.periodChange !== 0);
    const byMove = [...withMoves].sort((a, b) => b.periodChange - a.periodChange);

    res.json({
      periodStart: start,
      periodEnd: end,
      totalValue,
      periodChange: Math.round(periodChange * 100) / 100,
      periodChangePct: priorValue > 0 ? Math.round(periodChange / priorValue * 10000) / 100 : 0,
      allTimeChange: Math.round(allTimeChange * 100) / 100,
      allTimePct: totalValue - allTimeChange > 0 ? Math.round(allTimeChange / (totalValue - allTimeChange) * 10000) / 100 : 0,
      holdings,
      topGainers: byMove.slice(0, 5).filter(h => h.periodChange > 0),
      topLosers: byMove.slice(-5).reverse().filter(h => h.periodChange < 0),
    });
  } catch (err) {
    console.error('monarch-investments error:', err);
    res.status(502).json({ error: 'GetInvestments failed: ' + err.message });
  }
});

function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = parseFloat(v.replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; }
  return 0;
}

// Unwrap a FastMCP tool result into its parsed JSON payload
function unwrapMCPResult(toolResult) {
  let payload = toolResult?.result?.structuredContent?.result
    ?? (toolResult?.result?.content ?? []).find(b => b.type === 'text')?.text
    ?? toolResult?.result
    ?? null;
  // Parse JSON strings, possibly double-wrapped as {result: "..."}
  for (let i = 0; i < 2; i++) {
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { break; }
    }
    if (payload && typeof payload === 'object' && typeof payload.result === 'string') {
      try { payload = JSON.parse(payload.result); continue; } catch { break; }
    }
    break;
  }
  return payload;
}

async function monarchMCPHandshake(accessToken) {
  _mcpSessionId = null;
  await callMonarchMCP(accessToken, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cohen-financial-planner', version: '1.0.0' },
  });
  // Fire-and-forget initialized notification
  try {
    const nh = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (_mcpSessionId) nh['Mcp-Session-Id'] = _mcpSessionId;
    await fetch(MONARCH_MCP, {
      method: 'POST', headers: nh,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* notifications may 202/204 with empty body — ignore */ }
}

// Resolve a promise but give up (with a fallback) after `ms` so a slow Monarch
// handshake can never hang the advisor response.
const withTimeout = (p, ms, fallback) =>
  Promise.race([p.catch(() => fallback), new Promise(r => setTimeout(() => r(fallback), ms))]);

// ── Monarch tools for the AI Advisor ─────────────────────────────────────────
// Expose Monarch's read-only MCP tools (the Get* family) to the advisor so it can
// query the user's LIVE financial data. Schemas are pulled from Monarch's own
// tools/list so the model always sees correct argument shapes. Cached briefly.
let _monarchAdvToolsCache = { ts: 0, tools: null };
async function getMonarchAdvisorTools(accessToken) {
  if (!accessToken) return [];
  const now = Date.now();
  if (_monarchAdvToolsCache.tools && (now - _monarchAdvToolsCache.ts) < 10 * 60 * 1000) {
    return _monarchAdvToolsCache.tools;
  }
  try {
    await monarchMCPHandshake(accessToken);
    const list = await callMonarchMCP(accessToken, 'tools/list');
    const raw = list?.result?.tools || list?.tools || [];
    // Anthropic's input_schema only accepts a clean JSON-Schema object — Monarch's schemas
    // carry extra keys ($schema, additionalProperties, title…) that trigger a 400
    // "Extra inputs are not permitted". Rebuild a minimal, valid schema.
    const cleanSchema = (s) => {
      const props = (s && s.properties && typeof s.properties === 'object') ? s.properties : {};
      const out = { type: 'object', properties: props };
      if (Array.isArray(s && s.required) && s.required.length) out.required = s.required;
      return out;
    };
    // Read-only only — the Get* family. Never expose Create/Update/Delete to the advisor.
    const tools = raw
      .filter(t => /^Get/.test(t.name || ''))
      .map(t => ({
        name: 'monarch_' + t.name,
        description: ('[Live Monarch data] ' + (t.description || t.name)).slice(0, 900),
        input_schema: cleanSchema(t.inputSchema),
      }));
    _monarchAdvToolsCache = { ts: now, tools };
    return tools;
  } catch (e) {
    console.error('Monarch advisor tools/list failed:', e.message);
    return [];
  }
}
// Execute one Monarch read tool call from the advisor; returns a compact string for the model.
async function runMonarchAdvisorTool(accessToken, toolName, args) {
  const realName = String(toolName || '').replace(/^monarch_/, '');
  if (!/^Get/.test(realName)) return { error: 'Only read-only Monarch tools are allowed.' };
  try {
    const r = await callMonarchMCP(accessToken, 'tools/call', { name: realName, arguments: args || {} });
    if (r?.error) return { error: r.error.message || JSON.stringify(r.error) };
    const data = unwrapMCPResult(r);
    let out = typeof data === 'string' ? data : JSON.stringify(data);
    if (out && out.length > 8000) out = out.slice(0, 8000) + ' …[truncated]';
    return out || '(no data)';
  } catch (e) {
    return { error: e.message };
  }
}

app.get('/api/monarch-snapshot', requireAuth, async (req, res) => {
  try {
    const accessToken = await getMonarchAccessToken();
    if (!accessToken) {
      return res.status(401).json({ error: 'Monarch not connected', connectUrl: '/api/monarch-connect' });
    }

    await monarchMCPHandshake(accessToken);

    const toolResult = await callMonarchMCP(accessToken, 'tools/call', {
      name: 'GetAccounts',
      arguments: {},
    });
    if (toolResult?.error) {
      return res.status(502).json({ error: 'GetAccounts error: ' + (toolResult.error.message || JSON.stringify(toolResult.error)) });
    }

    const data = unwrapMCPResult(toolResult);
    const accounts = Array.isArray(data) ? data : (data?.accounts ?? data?.data ?? []);

    const excludes       = new Set((process.env.MONARCH_EXCLUDE_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean));
    const liquidExcludes = new Set((process.env.MONARCH_LIQUID_EXCLUDE || '').split(',').map(s => s.trim()).filter(Boolean));

    const matches = (acct, set) =>
      set.has(acct.id) || set.has(acct.name) || set.has(acct.displayName);

    // Compute everything from the account list (signed balances: assets +, liabilities -).
    // This is robust to Monarch's "hide from balances" flag: as long as an account
    // appears in GetAccounts, it counts here — so the 401k can stay hidden in Monarch.
    let retirement = 0, liquid = 0, assetsTotal = 0, liabTotal = 0, newestAt = null;
    const debugAccts = [];

    for (const acct of accounts) {
      if (matches(acct, excludes)) continue;
      const bal  = num(acct.currentBalance ?? acct.balance ?? acct.current_balance ?? acct.displayBalance);
      const name = acct.displayName ?? acct.name ?? '';
      const type = String(acct.type?.name ?? acct.type ?? '').toLowerCase();
      const sub  = String(acct.subtype?.name ?? acct.subtype ?? '').toLowerCase();
      const hay  = `${type} ${sub} ${name.toLowerCase()}`.replace(/[\s-]/g, '_');
      // 401k/403b/457/pension only — IRAs are treated as liquid net worth
      const isRetirement = /401|403b|457|pension/.test(hay);
      const isPLOC = matches(acct, liquidExcludes);

      // Totals (net worth) include everything
      if (bal >= 0) assetsTotal += bal; else liabTotal += Math.abs(bal);

      if (isRetirement) {
        retirement += Math.abs(bal);          // 401k → retirement, out of liquid
      } else if (!isPLOC) {
        liquid += bal;                         // everything else (incl. IRAs, credit cards) → liquid
      }
      // PLOC is excluded from liquid (but still in net-worth totals above)

      const updAt = acct.updatedAt ?? acct.displayLastUpdatedAt ?? acct.updated_at;
      if (updAt) { const d = new Date(updAt); if (!newestAt || d > new Date(newestAt)) newestAt = updAt; }
      debugAccts.push({ name, type, bal, isRetirement, isPLOC });
    }

    const netWorth = assetsTotal - liabTotal;

    // Build portfolio accounts for Portfolio tab
    const portfolioAccts = [];
    for (const acct of accounts) {
      if (matches(acct, excludes)) continue;
      const bal  = num(acct.currentBalance ?? acct.balance ?? acct.current_balance ?? acct.displayBalance);
      const name = acct.displayName ?? acct.name ?? '';
      const type = String(acct.type?.name ?? acct.type ?? '').toLowerCase().replace(/[\s-]/g, '_');
      const sub  = String(acct.subtype?.name ?? acct.subtype ?? '').toLowerCase().replace(/[\s-]/g, '_');
      const inst = acct.institution?.name ?? acct.institutionName ?? acct.institution ?? '';
      const hay  = `${type} ${sub}`;
      const isRet = /401|403b|457|pension/.test(`${hay} ${name}`.toLowerCase().replace(/[\s-]/g, '_'));
      let category;
      if (isRet) category = 'retirement';
      else if (/credit|credit_card/.test(hay) || bal < 0) category = 'liability';
      else if (/loan|mortgage|debt/.test(hay)) category = 'liability';
      else if (/checking|savings|money_market|cd|cash/.test(hay)) category = 'cash';
      else if (/brokerage|investment|taxable|crypto/.test(hay)) category = 'investment';
      else if (/real_estate|property|home|vehicle/.test(hay)) category = 'other_asset';
      else category = 'other';
      const updAt = acct.updatedAt ?? acct.displayLastUpdatedAt ?? acct.updated_at ?? null;
      portfolioAccts.push({ name, institution: inst, type, subtype: sub, category, balance: Math.round(bal), updatedAt: updAt });
    }

    const updatedAt = newestAt ?? new Date().toISOString();
    res.json({
      netWorth:    { value: Math.round(netWorth),    updatedAt },
      liquid:      { value: Math.round(liquid),      updatedAt },
      assets:      { value: Math.round(assetsTotal), updatedAt },
      liabilities: { value: Math.round(liabTotal),   updatedAt },
      retirement:  retirement > 0 ? { value: Math.round(retirement), updatedAt } : null,
      accounts: portfolioAccts,
      _debug: { accountCount: accounts.length, retirement, liquid, netWorth, accounts: debugAccts },
    });
  } catch (err) {
    console.error('Monarch snapshot error:', err);
    res.status(502).json({ error: 'Monarch snapshot error: ' + err.message });
  }
});

// Extract income+expense pair from a GetCashFlow response (any shape)
function extractCashflowPair(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // Converts any value to a positive number: handles numbers, strings, and
  // nested objects like {total: 80000} or {amount: -80000}
  const toNum = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return Math.abs(v);
    if (typeof v === 'string') {
      const n2 = parseFloat(v.replace(/[^0-9.\-]/g, ''));
      return isNaN(n2) ? null : Math.abs(n2);
    }
    if (typeof v === 'object' && !Array.isArray(v)) {
      for (const k of ['total', 'sum', 'amount', 'value', 'totalAmount', 'total_amount']) {
        if (typeof v[k] === 'number') return Math.abs(v[k]);
      }
    }
    return null;
  };

  const INC = ['income', 'total_income', 'totalIncome', 'income_total', 'incomeTotal',
               'sumIncome', 'sum_income', 'incomeSum'];
  const EXP = ['total_expense', 'expenses', 'expense', 'spending', 'total_expenses',
               'totalExpenses', 'totalSpending', 'expense_total', 'expenseTotal',
               'spendingTotal', 'sumExpense', 'sumExpenses', 'sum_expense',
               'sum_expenses', 'expenseSum'];

  // ── Array: sum income and expense across all monthly/category items ──
  if (Array.isArray(obj)) {
    let totalInc = 0, totalExp = 0, foundInc = false, foundExp = false;
    for (const item of obj) {
      if (!item || typeof item !== 'object') continue;
      for (const k of INC) { const v = toNum(item[k]); if (v != null) { totalInc += v; foundInc = true; break; } }
      for (const k of EXP) { const v = toNum(item[k]); if (v != null) { totalExp += v; foundExp = true; break; } }
    }
    if (foundInc || foundExp) return { income: totalInc, expense: totalExp };
    // Recurse into single-item arrays
    if (obj.length === 1) return extractCashflowPair(obj[0]);
    return null;
  }

  // ── Object: try direct fields (numbers OR nested {total:X} objects) ──
  let inc = null, exp = null;
  for (const k of INC) { const v = toNum(obj[k]); if (v != null) { inc = v; break; } }
  for (const k of EXP) { const v = toNum(obj[k]); if (v != null) { exp = v; break; } }
  if (inc != null || exp != null) return { income: inc ?? 0, expense: exp ?? 0 };

  // ── Recurse into array container keys (monthly entries) ──
  for (const k of ['months', 'byMonth', 'by_month', 'monthly', 'items', 'entries', 'rows', 'periods']) {
    if (Array.isArray(obj[k]) && obj[k].length > 0) {
      const r = extractCashflowPair(obj[k]);
      if (r) return r;
    }
  }

  // ── Recurse into object container keys ──
  for (const k of ['summary', 'totals', 'cashFlow', 'cash_flow', 'aggregate',
                   'data', 'result', 'overview', 'total', 'breakdown']) {
    if (obj[k] && typeof obj[k] === 'object') {
      const r = extractCashflowPair(obj[k]);
      if (r) return r;
    }
  }

  return null;
}

// Pull a single numeric total out of a filtered GetCashFlow result
function extractCashflowTotal(obj) {
  if (obj == null) return null;
  if (typeof obj === 'number') return obj;
  if (typeof obj === 'string') { const n2 = num(obj); return n2 || null; }
  if (Array.isArray(obj)) {
    // Sum only if it looks like a flat list of amounts (not nested summaries)
    let sum = 0, found = false;
    for (const item of obj) {
      if (typeof item === 'number') { sum += item; found = true; continue; }
      if (typeof item === 'object' && item != null) {
        for (const k of ['total', 'sum', 'amount', 'value']) {
          if (item[k] != null) { sum += num(item[k]); found = true; break; }
        }
      }
    }
    return found ? sum : null;
  }
  for (const k of ['total', 'sum', 'amount', 'total_amount', 'value', 'sum_amount', 'totalAmount']) {
    if (obj[k] != null) return num(obj[k]);
  }
  return null;
}

// YTD cash flow (Jan 1 → today): income and expense totals
app.get('/api/monarch-cashflow', requireAuth, async (req, res) => {
  try {
    const accessToken = await getMonarchAccessToken();
    if (!accessToken) return res.status(401).json({ error: 'Monarch not connected', connectUrl: '/api/monarch-connect' });

    const now = new Date();
    const start = `${now.getFullYear()}-01-01`;
    const end = now.toISOString().slice(0, 10);

    await monarchMCPHandshake(accessToken);

    // Single call — no category filter — to get the unified income+expense summary
    const trAll = await callMonarchMCP(accessToken, 'tools/call', {
      name: 'GetCashFlow',
      arguments: { start_date: start, end_date: end },
    });
    if (trAll?.error) throw new Error(`GetCashFlow: ${trAll.error.message || JSON.stringify(trAll.error)}`);
    const rawAll = unwrapMCPResult(trAll);

    // Log shape for debugging (visible in Railway logs)
    console.log('[cashflow] raw type:', Array.isArray(rawAll) ? `array[${rawAll.length}]` : typeof rawAll);
    if (rawAll && typeof rawAll === 'object') {
      console.log('[cashflow] top-level keys:', Array.isArray(rawAll) ? `item0 keys: ${Object.keys(rawAll[0]||{}).join(',')}` : Object.keys(rawAll).join(','));
    }

    const pair = extractCashflowPair(rawAll);
    console.log('[cashflow] extracted pair:', pair);
    // Only trust the single unfiltered call if it found BOTH sides — otherwise
    // fall through to the dual filtered calls (the approach that worked before).
    if (pair && pair.income > 0 && pair.expense > 0) {
      return res.json({ start, end, income: Math.round(pair.income), expense: Math.round(pair.expense), _debug: { raw: rawAll } });
    }

    // Fallback: two separate filtered calls
    async function flowFor(categoryType) {
      const tr2 = await callMonarchMCP(accessToken, 'tools/call', {
        name: 'GetCashFlow',
        arguments: { start_date: start, end_date: end, filters: JSON.stringify({ category_type: categoryType }) },
      });
      if (tr2?.error) throw new Error(`GetCashFlow(${categoryType}): ${tr2.error.message || JSON.stringify(tr2.error)}`);
      const parsed = unwrapMCPResult(tr2);
      return { total: extractCashflowTotal(parsed), raw: parsed };
    }

    const [income, expense] = await Promise.all([flowFor('income'), flowFor('expense')]);
    res.json({
      start, end,
      income:  Math.abs(Math.round(income.total ?? 0)),
      expense: Math.abs(Math.round(expense.total ?? 0)),
      _debug: { raw: rawAll, incomeRaw: income.raw, expenseRaw: expense.raw },
    });
  } catch (err) {
    console.error('Monarch cashflow error:', err);
    res.status(502).json({ error: 'Monarch cashflow error: ' + err.message });
  }
});

// ── Snapshots (annual history) ──────────────────────────────────────────────
app.get('/api/snapshots', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM snapshots ORDER BY created_at ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('GET snapshots error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/snapshots', requireAuth, async (req, res) => {
  try {
    const { id, label, planYear, params, summary } = req.body;
    await db.query(
      `INSERT INTO snapshots (id, label, plan_year, params, summary)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET label=$2, plan_year=$3, params=$4, summary=$5`,
      [id, label, planYear, JSON.stringify(params), JSON.stringify(summary)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST snapshot error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/snapshots/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM snapshots WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE snapshot error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Advisor chats ─────────────────────────────────────────────────────────────
app.get('/api/chats', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, title, jsonb_array_length(messages) AS message_count, created_at, updated_at
       FROM advisor_chats ORDER BY updated_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET chats error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/chats/:id', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM advisor_chats WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('GET chat error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/chats', requireAuth, async (req, res) => {
  try {
    const { id, title } = req.body;
    await db.query(
      `INSERT INTO advisor_chats (id, title, messages) VALUES ($1, $2, '[]')
       ON CONFLICT (id) DO NOTHING`,
      [id, title || 'New conversation']
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST chat error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/chats/:id', requireAuth, async (req, res) => {
  try {
    const { title, messages } = req.body;
    if (title !== undefined) {
      await db.query(
        'UPDATE advisor_chats SET title=$1, updated_at=NOW() WHERE id=$2',
        [title, req.params.id]
      );
    }
    if (messages !== undefined) {
      await db.query(
        'UPDATE advisor_chats SET messages=$1, updated_at=NOW() WHERE id=$2',
        [JSON.stringify(messages), req.params.id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT chat error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/chats/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM advisor_chats WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE chat error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Anthropic proxy — SSE streaming ──────────────────────────────────────────
app.post('/api/advisor/stream', requireAuth, advisorLimiter, async (req, res) => {
  const { chatId, message, systemPrompt, messages } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: 'chatId and message required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  // Anthropic requires ≥1 message. The auto-brief sends messages:[] with the prompt in `message`,
  // so fall back to a single user turn built from `message` when the array is empty.
  const apiMessages = (Array.isArray(messages) && messages.length) ? messages : [{ role: 'user', content: message }];

  // Warm the SSE connection immediately so the client doesn't see an idle socket
  // dropped ("Load failed") while we set up Monarch access below.
  res.write(': keep-alive\n\n');

  // Declared outside the try so the catch block can persist whatever text streamed to the
  // client before a later loop iteration failed (e.g. Anthropic returns a transient 5xx on
  // the 2nd tool-use round) — previously the DB write only happened after the whole loop
  // completed, so a reply the user already saw appear on screen was silently never saved.
  let fullReply = '';

  try {
    // Give the advisor live read-only access to Monarch when the user has connected it.
    const accessToken = await withTimeout(getMonarchAccessToken(), 5000, null);
    const monarchTools = await withTimeout(getMonarchAdvisorTools(accessToken), 7000, []);
    const sys = systemPrompt + (monarchTools.length ? `

═══ LIVE MONARCH ACCESS ═══
You can query the user's REAL Monarch Money data with the monarch_* tools (accounts & balances, transactions, cash flow, spending by category, investments, recurring, net worth history, and more). When the user asks about actual spending, balances, holdings, budgets, or recent activity, CALL these tools and answer from real data instead of the plan's assumptions. Dates are ISO (YYYY-MM-DD). Today is ${new Date().toISOString().slice(0,10)}. Be specific with real numbers and say when a figure comes from live Monarch data.` : '');

    let convo = apiMessages.slice();
    let lastUsage = null;
    let loop = 0;
    while (loop++ < 6) {
      const stream = anthropic.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
        messages: convo,
        ...(monarchTools.length ? { tools: monarchTools } : {}),
      });
      stream.on('text', (text) => { fullReply += text; send({ delta: text }); });
      const msg = await stream.finalMessage();
      lastUsage = msg.usage;

      if (msg.stop_reason === 'tool_use') {
        const toolResults = [];
        for (const block of msg.content) {
          if (block.type !== 'tool_use') continue;
          send({ tool_call: { name: block.name } });
          const result = accessToken
            ? await runMonarchAdvisorTool(accessToken, block.name, block.input)
            : { error: 'Monarch is not connected.' };
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          });
        }
        convo = [...convo, { role: 'assistant', content: msg.content }, { role: 'user', content: toolResults }];
        continue;
      }
      break;
    }

    // Persist atomically — only after a successful stream
    const pair = [
      { role: 'user', content: message },
      { role: 'assistant', content: fullReply },
    ];
    await db.query(
      `UPDATE advisor_chats SET messages = messages || $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(pair), chatId]
    );

    const countRes = await db.query(
      `SELECT jsonb_array_length(messages) AS cnt FROM advisor_chats WHERE id = $1`,
      [chatId]
    );
    if ((countRes.rows[0]?.cnt || 0) <= 2) {
      const title = message.slice(0, 60) + (message.length > 60 ? '…' : '');
      await db.query('UPDATE advisor_chats SET title=$1 WHERE id=$2', [title, chatId]);
    }

    send({ done: true, usage: lastUsage });
    res.end();
  } catch (err) {
    console.error('Advisor stream error:', err);
    // If we'd already streamed partial text to the client before this failure, persist it
    // rather than silently dropping it — otherwise the user sees a reply on screen that
    // never made it into the chat's saved history.
    if (fullReply) {
      const pair = [
        { role: 'user', content: message },
        { role: 'assistant', content: fullReply },
      ];
      try {
        await db.query(
          `UPDATE advisor_chats SET messages = messages || $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(pair), chatId]
        );
      } catch (dbErr) {
        console.error('Advisor stream: failed to persist partial reply:', dbErr);
      }
    }
    send({ error: (err.message || 'Anthropic API error').slice(0, 200) });
    res.end();
  }
});

// ── Anthropic proxy — agentic mode (tool-use + streaming) ────────────────────
app.post('/api/advisor/agentic', requireAuth, advisorLimiter, async (req, res) => {
  const { chatId, message, systemPrompt, messages, currentParams } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: 'chatId and message required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  let aiParams = { ...(currentParams || {}) };
  const proposedChanges = [];
  let conversationMsgs = (Array.isArray(messages) && messages.length) ? [...messages] : [{ role: 'user', content: message }];
  let fullReply = '';

  const agenticSystemPrompt = systemPrompt + `

═══ AGENTIC MODE ═══
You have tools to compute changes to Norm's plan in a sandbox (a full copy of his current inputs). Nothing you do here touches his real data by itself — after you finish, he sees an exact diff and picks where it goes: apply directly to his live plan, update an existing saved scenario, or save as a new one. So when he asks you to "update," "change," or "set" something directly (e.g. "update my 2027 income to $320K"), that's exactly what set_param is for — compute the precise change he described, don't just discuss it in prose.

Tools available:
• set_param(key, value, reason) — stage one parameter change. See the full key reference below.
• run_projection() — compute key metrics (final NW, deficit years, worst surplus, total tuition, liquid) with the current sandbox params. Call this after set_param calls to show impact.
• save_scenario(name) — suggest a name for the change set (used to prefill the "save as new scenario" box he'll see — he can still rename it or choose a different destination).

═══ PARAMETER KEY REFERENCE ═══
Per-year income (Y0=the plan's start year, Y1=+1yr, … Y10=+10yr — see "PER-YEAR INCOME INPUTS" above in the live state for the actual years and current values):
• normTCY0 through normTCY10 — Norm's TOTAL comp (cash + stock/RSU combined — they're taxed identically as ordinary income at vest, so there's no separate cash/stock split) for each of the next 11 years.
• nancyW2Y0, nancyW2Y1, nancyW2Y2, nancyW2Y3 — Nancy's W2 income in each of the next 4 years (only actually used for years before nancyRampYear — see below)
Beyond Y10, Norm's income instead compounds forward automatically from Y10's value at normGrowth (no year-specific key needed — change normGrowth or normTCY10 itself). Nancy's income beyond nancyRampYear is computed from nancyHourlyRate × client ramp (nancyRampClients→nancyMaxClients over nancyRampYears), not from a per-year field.

Other editable keys: homePrice, downPctg, mortgageRate, homePurchaseYear, propTaxRate, investReturn, startingLiquid, expenseInflation, normGrowth, nancyHourlyRate, nancyMaxClients, nancyRampClients, nancyRampYear, nancyRampYears, nancyWeeksPerYear, pretax401k, mcVol, tuitionInflation, homeAppreciation, capGainsTaxRate, numKids, planStartYear.

If a request is genuinely ambiguous about WHICH income he means (e.g. just "update my income" with no further context — could be Norm, Nancy, cash vs stock, or a specific year), ask him to clarify rather than guessing which key to change. If he names a year and a person, or the context makes it clear, just do it.

Workflow: understand what he's asking → set_param for each change → run_projection → interpret results → optionally save_scenario if it's worth naming. Be specific and quantitative in your analysis.`;

  // Live read-only Monarch access (same tools as the normal chat) so the AI can ground
  // its proposals in real balances, spending and holdings — not just plan assumptions.
  const monarchAccessToken = await withTimeout(getMonarchAccessToken(), 5000, null);
  const monarchTools = await withTimeout(getMonarchAdvisorTools(monarchAccessToken), 7000, []);
  const fullSystemPrompt = agenticSystemPrompt + (monarchTools.length ? `

═══ LIVE MONARCH ACCESS ═══
You also have monarch_* tools to read Norm's REAL Monarch Money data (accounts, transactions, cash flow, spending by category, investments, recurring, net worth history). Use them to ground proposals in actual numbers. Dates are ISO; today is ${new Date().toISOString().slice(0,10)}.` : '');

  try {
    let loopCount = 0;
    while (loopCount++ < 8) {
      let streamText = '';
      const stream = anthropic.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: [{ type: 'text', text: fullSystemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: conversationMsgs,
        tools: [...ADVISOR_TOOLS, ...monarchTools],
      });

      stream.on('text', (text) => {
        streamText += text;
        fullReply += text;
        send({ delta: text });
      });

      const msg = await stream.finalMessage();

      if (msg.stop_reason === 'end_turn') break;

      if (msg.stop_reason === 'tool_use') {
        const toolResults = [];
        for (const block of msg.content) {
          if (block.type !== 'tool_use') continue;
          let result;

          if (block.name === 'set_param') {
            const { key, value, reason } = block.input;
            const old = aiParams[key];
            aiParams[key] = value;
            proposedChanges.push({ key, oldValue: old, value, reason });
            send({ tool_call: { name: 'set_param', key, oldValue: old, value, reason } });
            result = { ok: true, key, value };

          } else if (block.name === 'run_projection') {
            try {
              const proj = runModel(aiParams);
              const R = proj.R;
              const last = R[R.length - 1];
              result = {
                finalNW: last.nw,
                finalK401: last.k401,
                deficitYears: R.filter(r => r.surp < 0).length,
                worstSurplus: Math.min(...R.map(r => r.surp)),
                totalTuition: proj.tT,
                finalLiquid: last.liq,
              };
            } catch (e) {
              result = { error: e.message };
            }
            send({ tool_call: { name: 'run_projection', result } });

          } else if (block.name === 'save_scenario') {
            send({ tool_call: { name: 'save_scenario', scenarioName: block.input.name, aiParams: { ...aiParams } } });
            result = { ok: true, name: block.input.name };

          } else if (block.name && block.name.startsWith('monarch_')) {
            send({ tool_call: { name: block.name } });
            result = monarchAccessToken
              ? await runMonarchAdvisorTool(monarchAccessToken, block.name, block.input)
              : { error: 'Monarch is not connected.' };
          }

          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
        }

        conversationMsgs = [
          ...conversationMsgs,
          { role: 'assistant', content: msg.content },
          { role: 'user', content: toolResults },
        ];
      } else {
        break;
      }
    }

    // Persist final text atomically
    if (fullReply) {
      const pair = [
        { role: 'user', content: message },
        { role: 'assistant', content: fullReply },
      ];
      await db.query(
        `UPDATE advisor_chats SET messages = messages || $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(pair), chatId]
      );
      const countRes = await db.query(
        `SELECT jsonb_array_length(messages) AS cnt FROM advisor_chats WHERE id = $1`, [chatId]
      );
      if ((countRes.rows[0]?.cnt || 0) <= 2) {
        const title = message.slice(0, 60) + (message.length > 60 ? '…' : '');
        await db.query('UPDATE advisor_chats SET title=$1 WHERE id=$2', [title, chatId]);
      }
    }

    send({ done: true, proposedChanges, aiParams });
    res.end();
  } catch (err) {
    console.error('Advisor agentic error:', err);
    // Same gap as /api/advisor/stream: persist any partial reply already shown to the
    // client before a later tool-use round failed, instead of silently dropping it.
    if (fullReply) {
      const pair = [
        { role: 'user', content: message },
        { role: 'assistant', content: fullReply },
      ];
      try {
        await db.query(
          `UPDATE advisor_chats SET messages = messages || $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(pair), chatId]
        );
      } catch (dbErr) {
        console.error('Advisor agentic: failed to persist partial reply:', dbErr);
      }
    }
    send({ error: (err.message || 'Anthropic API error').slice(0, 200) });
    res.end();
  }
});

// ── Anthropic proxy — non-streaming fallback ──────────────────────────────────
app.post('/api/advisor/message', requireAuth, advisorLimiter, async (req, res) => {
  const { chatId, message, systemPrompt, messages } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: 'chatId and message required' });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages,
    });

    const reply = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    const pair = [
      { role: 'user', content: message },
      { role: 'assistant', content: reply },
    ];
    await db.query(
      `UPDATE advisor_chats SET messages = messages || $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(pair), chatId]
    );

    const countRes = await db.query(
      `SELECT jsonb_array_length(messages) AS cnt FROM advisor_chats WHERE id = $1`,
      [chatId]
    );
    if ((countRes.rows[0]?.cnt || 0) <= 2) {
      const title = message.slice(0, 60) + (message.length > 60 ? '…' : '');
      await db.query('UPDATE advisor_chats SET title=$1 WHERE id=$2', [title, chatId]);
    }

    res.json({ reply, usage: response.usage });
  } catch (err) {
    console.error('Advisor message error:', err);
    const msg = err.message || 'Anthropic API error';
    res.status(500).json({ error: msg.slice(0, 200) });
  }
});


// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// Start listening immediately — the login page and static assets don't need the DB, and
// every DB-touching route already catches its own errors and returns a graceful JSON 500
// (the frontend shows a toast, it doesn't take the app down). Previously app.listen() was
// gated entirely on initSchema() succeeding, and any failure called process.exit(1) — so a
// single transient DB connectivity blip during a fresh deploy's startup (common right after
// a container restarts and reconnects) took the WHOLE app offline. Combined with Railway's
// restartPolicyMaxRetries:3, three unlucky blips in a row would leave the app down until
// someone manually redeployed, even though the DB may have already recovered by then.
app.listen(PORT, () => console.log(`Cohen Planner running on port ${PORT}`));

async function initSchemaWithRetry(retries = 5, delayMs = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      await db.initSchema();
      console.log('DB schema ready');
      return;
    } catch (err) {
      console.error(`DB schema init attempt ${i + 1}/${retries} failed:`, err.message);
      if (i < retries - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  console.error('DB schema init failed after all retries — server is running but DB-dependent routes will error until this is resolved.');
}
initSchemaWithRetry();
