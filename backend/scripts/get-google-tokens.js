/**
 * get-google-tokens.js
 *
 * Run this once to get your Google OAuth2 refresh token.
 * It starts a local HTTP server, opens your browser to the Google consent screen,
 * and prints the refresh token to copy into your .env file.
 *
 * Usage:
 *   1. Make sure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set in backend/.env
 *   2. Add http://localhost:3000/oauth/callback as an authorized redirect URI
 *      in your Google Cloud Console → APIs & Services → Credentials
 *   3. Run: node scripts/get-google-tokens.js
 *   4. Authorize in the browser that opens
 *   5. Copy the printed GOOGLE_REFRESH_TOKEN into your .env file
 */

require('dotenv').config();
const http = require('http');
const { google } = require('googleapis');
const { exec } = require('child_process');
const url = require('url');

const REDIRECT_URI = 'http://localhost:3000/oauth/callback';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
];

function openBrowser(urlToOpen) {
  // macOS
  exec(`open "${urlToOpen}"`, (err) => {
    if (err) {
      console.log('\nCould not open browser automatically. Open this URL manually:');
      console.log(urlToOpen);
    }
  });
}

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // Force consent screen to always get a refresh token
  });

  console.log('\n=== Google OAuth Token Setup ===\n');
  console.log('Required scopes:');
  SCOPES.forEach((s) => console.log('  •', s));
  console.log('\nMake sure this redirect URI is registered in Google Cloud Console:');
  console.log(' ', REDIRECT_URI);
  console.log('\nOpening browser for authorization...\n');

  openBrowser(authUrl);

  // Start a local server to catch the OAuth callback
  const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);

    if (!parsedUrl.pathname.startsWith('/oauth/callback')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const code = parsedUrl.query.code;
    const error = parsedUrl.query.error;

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
      console.error('\nAuthorization denied:', error);
      server.close();
      process.exit(1);
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>No authorization code received</h1>');
      server.close();
      return;
    }

    try {
      const { tokens } = await oauth2Client.getToken(code);

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body style="font-family: sans-serif; padding: 40px; max-width: 600px;">
            <h1 style="color: green;">Authorization successful!</h1>
            <p>You can close this browser tab and check your terminal for the refresh token.</p>
          </body>
        </html>
      `);

      console.log('\n=== Authorization Successful! ===\n');
      console.log('Access Token (expires in ~1 hour — you don\'t need to save this):');
      console.log(tokens.access_token);
      console.log('\n--- Copy this into your .env file ---');
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log('--------------------------------------\n');

      if (!tokens.refresh_token) {
        console.warn(
          'WARNING: No refresh token returned. This can happen if you already authorized this app.\n' +
          'To force a new refresh token:\n' +
          '  1. Go to https://myaccount.google.com/permissions\n' +
          '  2. Revoke access for your app\n' +
          '  3. Run this script again\n'
        );
      }
    } catch (err) {
      console.error('\nFailed to exchange code for tokens:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>Token exchange failed</h1><p>${err.message}</p>`);
    }

    server.close(() => process.exit(0));
  });

  server.listen(3000, () => {
    console.log('Waiting for OAuth callback on http://localhost:3000 ...');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('Error: Port 3000 is already in use. Stop whatever is running on port 3000 and try again.');
    } else {
      console.error('Server error:', err.message);
    }
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
