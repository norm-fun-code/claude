/**
 * get-monarch-mcp-token.js
 *
 * Run this ONCE to authorize NormOS against Monarch's MCP server and get a
 * long-lived refresh token. Monarch's OAuth supports Dynamic Client Registration
 * + PKCE (authorization_code) but has NO machine-to-machine (client_credentials)
 * grant — so a one-time browser login is required. After that, the backend mints
 * access tokens from the refresh token forever, no browser needed.
 *
 * What it does:
 *   1. Self-registers an OAuth client with Monarch (Dynamic Client Registration)
 *   2. Opens Monarch's login/consent screen in your browser (PKCE S256)
 *   3. Captures the auth code on a local callback server
 *   4. Exchanges it for an access token + refresh token
 *   5. Prints the values to copy into Railway env vars
 *
 * Usage:
 *   node scripts/get-monarch-mcp-token.js
 *   → log in to Monarch in the browser that opens, approve access
 *   → copy the printed MONARCH_MCP_* values into Railway
 */

const http = require('http');
const crypto = require('crypto');
const url = require('url');
const { exec } = require('child_process');
const axios = require('axios');

const AUTH_BASE = process.env.MONARCH_OAUTH_BASE || 'https://api.monarch.com';
const REGISTER_URL = `${AUTH_BASE}/oauth/register`;
const AUTHORIZE_URL = `${AUTH_BASE}/oauth/authorize/`;
const TOKEN_URL = `${AUTH_BASE}/oauth/token/`;
const MCP_RESOURCE = process.env.MONARCH_MCP_URL || 'https://api.monarch.com/mcp';
const SCOPE = 'mcp:read mcp:write';

const CALLBACK_PORT = Number(process.env.MONARCH_OAUTH_CALLBACK_PORT || 8723);
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

const base64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function openBrowser(target) {
  // macOS `open`; falls back to printing the URL on other platforms / failures.
  exec(`open "${target}"`, (err) => {
    if (err) {
      console.log('\nCould not open the browser automatically. Open this URL manually:\n');
      console.log(target, '\n');
    }
  });
}

async function registerClient() {
  // Public client (token_endpoint_auth_method: "none") authenticated by PKCE.
  const { data } = await axios.post(
    REGISTER_URL,
    {
      client_name: 'NormOS',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    },
    { headers: { 'Content-Type': 'application/json' } }
  );
  return { clientId: data.client_id, clientSecret: data.client_secret || null };
}

async function main() {
  console.log('\n=== Monarch MCP OAuth Setup ===\n');
  console.log('Registering an OAuth client with Monarch…');

  let clientId, clientSecret;
  try {
    ({ clientId, clientSecret } = await registerClient());
  } catch (err) {
    console.error('Dynamic client registration failed:', err.response?.status, err.response?.data || err.message);
    process.exit(1);
  }
  console.log('  client_id:', clientId);
  if (clientSecret) console.log('  client_secret: (issued — will be needed at runtime)');

  // PKCE + CSRF state.
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  const authUrl =
    `${AUTHORIZE_URL}?` +
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      resource: MCP_RESOURCE,
    }).toString();

  console.log('\nOpening Monarch authorization in your browser…');
  console.log('(Make sure you are logged into the correct Monarch account.)\n');
  openBrowser(authUrl);

  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    if (!parsed.pathname.startsWith('/callback')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const { code, error, state: returnedState } = parsed.query;
    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
      console.error('\nAuthorization denied:', error);
      server.close(() => process.exit(1));
      return;
    }
    if (returnedState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>State mismatch</h1><p>Possible CSRF — aborting.</p>');
      console.error('\nState mismatch — aborting for safety.');
      server.close(() => process.exit(1));
      return;
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>No authorization code received</h1>');
      return;
    }

    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
        resource: MCP_RESOURCE,
      });
      if (clientSecret) body.set('client_secret', clientSecret);

      const { data } = await axios.post(TOKEN_URL, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<html><body style="font-family: sans-serif; padding: 40px; max-width: 600px;">
          <h1 style="color: green;">Monarch authorization successful!</h1>
          <p>You can close this tab and return to your terminal for the tokens.</p>
        </body></html>`
      );

      if (!data.refresh_token) {
        console.warn(
          '\nWARNING: No refresh token returned. Without one the backend can\'t mint ' +
            'access tokens long-term. Try revoking the NormOS app in Monarch and re-running.'
        );
      }

      console.log('\n=== Success! Copy these into Railway env ===\n');
      console.log(`MONARCH_MCP_REFRESH_TOKEN=${data.refresh_token || '(none returned)'}`);
      console.log(`MONARCH_MCP_CLIENT_ID=${clientId}`);
      if (clientSecret) console.log(`MONARCH_MCP_CLIENT_SECRET=${clientSecret}`);
      console.log('\n(Access token below is short-lived — no need to save it.)');
      console.log('access_token:', data.access_token);
      console.log('expires_in:', data.expires_in, 'seconds');
      console.log('\n============================================\n');

      server.close(() => process.exit(0));
    } catch (err) {
      console.error('\nToken exchange failed:', err.response?.status, err.response?.data || err.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>Token exchange failed</h1><pre>${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>`);
      server.close(() => process.exit(1));
    }
  });

  server.listen(CALLBACK_PORT, () => {
    console.log(`Waiting for the OAuth callback on ${REDIRECT_URI} …`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Error: port ${CALLBACK_PORT} is in use. Free it or set MONARCH_OAUTH_CALLBACK_PORT and retry.`);
    } else {
      console.error('Server error:', err.message);
    }
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
