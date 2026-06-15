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
    description: 'Propose changing one parameter in the AI sandbox. Never modifies the user\'s actual plan.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Exact parameter key (e.g. homePrice, investReturn, startingLiquid)' },
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

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/login');
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
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',-apple-system,sans-serif;background:#f6f9fc;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#0a2540}
.card{background:#fff;border:1px solid #e6ebf1;border-radius:12px;padding:40px 36px;width:100%;max-width:380px;box-shadow:0 4px 16px rgba(50,71,92,.08)}
h1{font-size:20px;font-weight:700;margin-bottom:6px}
p{color:#425466;font-size:13px;margin-bottom:24px;line-height:1.5}
label{display:block;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.6px;color:#8898aa;margin-bottom:6px}
input{width:100%;background:#fafbfc;border:1px solid #d0d7de;color:#0a2540;font-family:inherit;font-size:14px;padding:11px 13px;border-radius:8px;outline:none;transition:border-color .15s}
input:focus{border-color:#635bff;box-shadow:0 0 0 3px rgba(99,91,255,.12)}
button{width:100%;background:#635bff;color:#fff;border:none;padding:12px;border-radius:8px;cursor:pointer;font-weight:600;font-size:14px;font-family:inherit;margin-top:16px;transition:background .15s}
button:hover{background:#4f48cc}
button:disabled{background:#adbdcc;cursor:not-allowed}
.err{background:#fceaee;border:1px solid rgba(205,61,100,.25);color:#cd3d64;padding:10px 12px;border-radius:6px;font-size:12px;margin-top:12px;display:none}
</style>
</head>
<body>
<div class="card">
  <h1>💰 Cohen Financial Planner</h1>
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
    req.session.authenticated = true;
    return res.json({ ok: true });
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
app.get('/api/debug/db', requireAuth, async (req, res) => {
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
    res.status(500).json({ error: err.message, stack: err.stack });
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

async function getMonarchAccessToken() {
  const stored = await monarchOAuthRow();
  if (!stored) return null;
  // Return cached access token if still valid (5-min buffer)
  if (stored.expires_at && Date.now() < stored.expires_at - 5 * 60 * 1000) {
    return stored.access_token;
  }
  // Try refresh_token
  if (!stored.refresh_token) return null;
  const r = await fetch(`${MONARCH_AUTH}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refresh_token,
      client_id: stored.client_id,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) {
    // Refresh failed — clear tokens so user reconnects
    await db.query("DELETE FROM oauth_tokens WHERE key='monarch'");
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
}

async function callMonarchMCP(accessToken, method, params = {}) {
  const r = await fetch(MONARCH_MCP, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`MCP ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

// Start OAuth flow — registers client dynamically, redirects to Monarch auth page
app.get('/api/monarch-connect', requireAuth, async (req, res) => {
  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/api/monarch-callback`;

    // Get or register OAuth client
    const clientRow = await db.query("SELECT data FROM oauth_tokens WHERE key='monarch_client'");
    let clientId = clientRow.rows[0]?.data?.client_id;
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

function parseMonarchAccounts(toolResult) {
  // MCP tool result content is an array of {type, text} blocks
  const text = (toolResult?.result?.content ?? []).find(b => b.type === 'text')?.text ?? '[]';
  try { return JSON.parse(text); } catch { return []; }
}

app.get('/api/monarch-snapshot', requireAuth, async (req, res) => {
  try {
    const accessToken = await getMonarchAccessToken();
    if (!accessToken) {
      return res.status(401).json({
        error: 'Monarch not connected',
        connectUrl: '/api/monarch-connect',
      });
    }

    // Discover and call the accounts tool
    const toolsList = await callMonarchMCP(accessToken, 'tools/list');
    const tools = toolsList?.result?.tools ?? [];

    // Find an accounts-related tool
    const accountTool = tools.find(t =>
      t.name.includes('account') || t.name.includes('net_worth') || t.name.includes('networth')
    ) ?? tools[0];

    if (!accountTool) {
      return res.status(502).json({ error: 'No MCP tools found', availableTools: tools.map(t => t.name) });
    }

    const toolResult = await callMonarchMCP(accessToken, 'tools/call', {
      name: accountTool.name,
      arguments: {},
    });

    // Try to parse accounts from tool result
    const raw = parseMonarchAccounts(toolResult);
    const accounts = Array.isArray(raw) ? raw : (raw.accounts ?? raw.data ?? []);

    const excludes     = new Set((process.env.MONARCH_EXCLUDE_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean));
    const liquidExcludes = new Set((process.env.MONARCH_LIQUID_EXCLUDE || '').split(',').map(s => s.trim()).filter(Boolean));

    const visible = accounts.filter(a =>
      !a.isHidden && !excludes.has(a.id) && !excludes.has(a.displayName) && !excludes.has(a.name)
    );

    let assets = 0, liabilities = 0, retirement = 0, liquidAssets = 0, liquidLiabilities = 0, newestAt = null;

    for (const acct of visible) {
      const bal = acct.currentBalance ?? acct.balance ?? 0;
      const sub = (acct.subtype?.name ?? acct.subtype ?? '').toLowerCase().replace(/[\s-]/g, '_');
      const name = acct.displayName ?? acct.name ?? '';
      const isLiquidExcluded = liquidExcludes.has(name) || liquidExcludes.has(acct.id);
      const isRetirement = RETIREMENT_SUBTYPES.has(sub) || sub.includes('401') || sub.includes('ira') || sub.includes('retirement');

      if (acct.isAsset ?? bal >= 0) {
        const pos = Math.max(0, bal);
        assets += pos;
        if (isRetirement) retirement += pos;
        if (!isRetirement && !isLiquidExcluded) liquidAssets += pos;
      } else {
        const abs = Math.abs(bal);
        liabilities += abs;
        if (!isLiquidExcluded) liquidLiabilities += abs;
      }

      const updAt = acct.updatedAt ?? acct.displayLastUpdatedAt;
      if (updAt) {
        const d = new Date(updAt);
        if (!newestAt || d > new Date(newestAt)) newestAt = updAt;
      }
    }

    const updatedAt = newestAt ?? new Date().toISOString();
    res.json({
      netWorth:    { value: Math.round(assets - liabilities),             updatedAt },
      liquid:      { value: Math.round(liquidAssets - liquidLiabilities), updatedAt },
      assets:      { value: Math.round(assets),                           updatedAt },
      liabilities: { value: Math.round(liabilities),                      updatedAt },
      retirement:  retirement > 0 ? { value: Math.round(retirement),     updatedAt } : null,
      _debug: { toolUsed: accountTool.name, accountCount: visible.length },
    });
  } catch (err) {
    console.error('Monarch snapshot error:', err);
    res.status(502).json({ error: 'Monarch snapshot error: ' + err.message });
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
app.post('/api/advisor/stream', requireAuth, async (req, res) => {
  const { chatId, message, systemPrompt, messages } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: 'chatId and message required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  try {
    let fullReply = '';
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages,
    });

    stream.on('text', (text) => {
      fullReply += text;
      send({ delta: text });
    });

    const msg = await stream.finalMessage();

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

    send({ done: true, usage: msg.usage });
    res.end();
  } catch (err) {
    console.error('Advisor stream error:', err);
    send({ error: (err.message || 'Anthropic API error').slice(0, 200) });
    res.end();
  }
});

// ── Anthropic proxy — agentic mode (tool-use + streaming) ────────────────────
app.post('/api/advisor/agentic', requireAuth, async (req, res) => {
  const { chatId, message, systemPrompt, messages, currentParams } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: 'chatId and message required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  let aiParams = { ...(currentParams || {}) };
  const proposedChanges = [];
  let conversationMsgs = [...messages];
  let fullReply = '';

  const agenticSystemPrompt = systemPrompt + `

═══ AGENTIC MODE ═══
You have tools to explore changes to Norm's plan in a sandbox. Changes never affect his live plan until he explicitly saves the scenario.

Tools available:
• set_param(key, value, reason) — propose changing a parameter. Available keys: homePrice, downPctg, mortgageRate, homePurchaseYear, investReturn, startingLiquid, expenseInflation, normCashBase, nancyHourlyRate, nancyMaxClients, nancyRampYears, pretax401k, mcVol, tuitionInflation, homeAppreciation, normGrowth, capGainsTaxRate
• run_projection() — compute key metrics with current sandbox params
• save_scenario(name) — propose saving this sandbox as a named scenario

Workflow: understand what he's asking → set_param for each change → run_projection → interpret results → save_scenario if it's a worthwhile alternative. Be specific and quantitative in your analysis.`;

  try {
    let loopCount = 0;
    while (loopCount++ < 8) {
      let streamText = '';
      const stream = anthropic.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: [{ type: 'text', text: agenticSystemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: conversationMsgs,
        tools: ADVISOR_TOOLS,
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
          }

          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
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
    send({ error: (err.message || 'Anthropic API error').slice(0, 200) });
    res.end();
  }
});

// ── Anthropic proxy — non-streaming fallback ──────────────────────────────────
app.post('/api/advisor/message', requireAuth, async (req, res) => {
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

db.initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Cohen Planner running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to init DB schema:', err);
    process.exit(1);
  });
