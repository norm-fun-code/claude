// Monarch MCP runtime: gives Ask Norm LIVE access to the user's Monarch Money
// account (real-time transactions, balances, accounts, cashflow) by attaching
// Monarch's remote MCP server to the Anthropic Messages API call. Anthropic
// executes the MCP tool calls server-side and returns the synthesized answer.
//
// Auth: Monarch uses OAuth (authorization_code + refresh_token, PKCE) with NO
// machine grant, so a one-time browser login via scripts/get-monarch-mcp-token.js
// seeds MONARCH_MCP_REFRESH_TOKEN + MONARCH_MCP_CLIENT_ID. At runtime we exchange
// the refresh token for short-lived access tokens (cached) and re-persist any
// ROTATED refresh token to the DB so a server restart still works.
//
// Dormant unless MONARCH_MCP_REFRESH_TOKEN + MONARCH_MCP_CLIENT_ID are set.
const axios = require('axios');
const { getSource, registerSource, updateConfig } = require('../store/sources');

const AUTH_BASE = process.env.MONARCH_OAUTH_BASE || 'https://api.monarch.com';
const TOKEN_URL = `${AUTH_BASE}/oauth/token/`;
const MCP_URL = process.env.MONARCH_MCP_URL || 'https://api.monarch.com/mcp';
const SOURCE_ID = 'monarch_mcp';
const MCP_BETA = 'mcp-client-2025-11-20';

let cachedAccess = null; // { token, expiresAt }

/** Cheap synchronous gate: configured if the bootstrap env seed is present. */
function isConfigured() {
  return Boolean(process.env.MONARCH_MCP_REFRESH_TOKEN && process.env.MONARCH_MCP_CLIENT_ID);
}

// DB config (holds the latest, possibly-rotated refresh token) takes precedence
// over the env seed; env is just the one-time bootstrap value.
async function getCredentials() {
  let refreshToken = process.env.MONARCH_MCP_REFRESH_TOKEN || null;
  let clientId = process.env.MONARCH_MCP_CLIENT_ID || null;
  let clientSecret = process.env.MONARCH_MCP_CLIENT_SECRET || null;
  try {
    const src = await getSource(SOURCE_ID);
    if (src?.config) {
      refreshToken = src.config.refreshToken || refreshToken;
      clientId = src.config.clientId || clientId;
      clientSecret = src.config.clientSecret || clientSecret;
    }
  } catch {
    /* DB optional — fall back to env seed */
  }
  return { refreshToken, clientId, clientSecret };
}

/** Mint (or reuse a cached) Monarch access token from the refresh token. */
async function getAccessToken() {
  if (cachedAccess && cachedAccess.expiresAt - Date.now() > 60_000) {
    return cachedAccess.token;
  }
  const { refreshToken, clientId, clientSecret } = await getCredentials();
  if (!refreshToken || !clientId) {
    throw new Error('Monarch MCP not configured — run scripts/get-monarch-mcp-token.js and set MONARCH_MCP_* env vars');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    resource: MCP_URL,
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  const { data } = await axios.post(TOKEN_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });

  const expiresIn = Number(data.expires_in) || 3600;
  cachedAccess = { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };

  // Monarch may rotate the refresh token on each use. Persist the new one so the
  // next process restart doesn't fall back to a now-invalid seed.
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    try {
      await registerSource({ id: SOURCE_ID, domain: 'wealth', displayName: 'Monarch (MCP)' });
      await updateConfig(SOURCE_ID, {
        refreshToken: data.refresh_token,
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
      });
    } catch (e) {
      console.error('[monarch-mcp] failed to persist rotated refresh token:', e.message);
    }
  }

  return cachedAccess.token;
}

/**
 * Answer a financial question with live Monarch data. Attaches Monarch's MCP
 * server to a single Anthropic call; Claude calls the Monarch tools server-side
 * and returns the synthesized text. Throws on auth/transport failure so the
 * caller can fall back to the local (PostgreSQL-grounded) path.
 */
async function answerWithMonarch({ system, prompt, maxTokens = 1600 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
  const token = await getAccessToken();

  const { data } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      system,
      messages: [{ role: 'user', content: prompt }],
      mcp_servers: [
        { type: 'url', url: MCP_URL, name: 'monarch', authorization_token: token },
      ],
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'monarch' }],
    },
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': MCP_BETA,
        'content-type': 'application/json',
      },
      timeout: Number(process.env.MONARCH_MCP_TIMEOUT_MS || 60000),
    }
  );

  // Final answer is in text blocks (mcp_tool_use/mcp_tool_result blocks are the
  // tool round-trip Anthropic ran server-side; thinking blocks are separate).
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text || '')
    .join('');
}

module.exports = { isConfigured, getAccessToken, answerWithMonarch, MCP_URL };
