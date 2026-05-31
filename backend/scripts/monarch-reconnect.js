#!/usr/bin/env node
// Re-mint the Monarch token when it expires, verify it, and update both the
// launchd plist (used by the daily Mac sync) and Railway (env for the server).
// Interactive: prompts for password + the emailed 6-digit code. Run on your Mac.
//
//   node scripts/monarch-reconnect.js
//
// Reads MONARCH_EMAIL if set, else defaults to the address baked in below.
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

const BASE = 'https://api.monarch.com';
const EMAIL = process.env.MONARCH_EMAIL || 'normanc41@gmail.com';
const PLIST = path.join(os.homedir(), 'Library/LaunchAgents/com.normos.monarch-sync.plist');
const LABEL = 'com.normos.monarch-sync';

function headers(deviceUuid) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: 'https://app.monarchmoney.com',
    'Client-Platform': 'web',
    'x-cio-client-platform': 'web',
    'x-cio-site-id': '2598be4aa410159198b2',
    'device-uuid': deviceUuid,
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
  };
}

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (hidden) {
      // Mask typed input (password).
      const stdout = process.stdout;
      rl._writeToOutput = (s) => { if (s.includes(question)) stdout.write(s); else stdout.write('*'); };
    }
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
  });
}

async function login(deviceUuid, password, emailOtp) {
  const body = {
    username: EMAIL, password,
    trusted_device: true, supports_mfa: true, supports_email_otp: true,
  };
  if (emailOtp) body.email_otp = emailOtp;
  const { data } = await axios.post(`${BASE}/auth/login/`, body, { headers: headers(deviceUuid), timeout: 20000 });
  return data;
}

async function verify(token) {
  const { data } = await axios.post(
    `${BASE}/graphql`,
    { query: 'query{accounts{displayName currentBalance}}' },
    { headers: { ...headers(crypto.randomUUID()), Authorization: `Token ${token}` }, timeout: 20000 }
  );
  if (data.errors) throw new Error(JSON.stringify(data.errors).slice(0, 200));
  return data.data.accounts || [];
}

function updatePlistToken(token) {
  if (!fs.existsSync(PLIST)) {
    console.log(`\n⚠ Plist not found at ${PLIST} — skipping launchd update.`);
    return false;
  }
  const xml = fs.readFileSync(PLIST, 'utf8');
  // Replace the value inside the MONARCH_TOKEN <key>…<string>VALUE</string> pair.
  const updated = xml.replace(
    /(<key>MONARCH_TOKEN<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${token}$2`
  );
  if (updated === xml) {
    console.log('\n⚠ Could not find MONARCH_TOKEN in plist — leaving it unchanged.');
    return false;
  }
  fs.writeFileSync(PLIST, updated);
  try {
    execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' });
    execFileSync('launchctl', ['load', PLIST], { stdio: 'ignore' });
    console.log('✓ Updated launchd plist and reloaded the daily sync job.');
  } catch (e) {
    console.log(`✓ Updated plist, but reload failed (${e.message}). Run:\n    launchctl unload ${PLIST} && launchctl load ${PLIST}`);
  }
  return true;
}

function updateRailway(token) {
  try {
    execFileSync('railway', ['variables', '--service', 'backend', '--set', `MONARCH_TOKEN=${token}`], { stdio: 'inherit' });
    console.log('✓ Updated MONARCH_TOKEN on Railway.');
  } catch (e) {
    console.log(`\n⚠ Could not update Railway automatically (${e.message}).`);
    console.log('  Set it manually:\n    railway variables --service backend --set "MONARCH_TOKEN=<token>"');
  }
}

async function main() {
  console.log(`Reconnecting Monarch for ${EMAIL}\n`);
  const deviceUuid = crypto.randomUUID();
  const password = await ask('Monarch password: ', { hidden: true });

  // Step 1: trigger the email OTP.
  console.log('\nRequesting login… (Monarch will email you a 6-digit code)');
  let data;
  try {
    data = await login(deviceUuid, password);
  } catch (err) {
    const code = err.response?.data?.error_code || err.response?.status;
    if (!String(code).includes('OTP') && err.response?.status !== 403) {
      // Some accounts get the token straight away (trusted device).
      if (err.response) throw new Error(`Login failed: ${JSON.stringify(err.response.data).slice(0, 200)}`);
      throw err;
    }
  }

  // Step 2: if no token yet, submit the emailed code.
  let token = data?.token;
  if (!token) {
    const otp = await ask('Enter the 6-digit code from your email: ');
    data = await login(deviceUuid, password, otp);
    token = data?.token;
  }
  if (!token) throw new Error('No token returned — check your password/code and try again.');

  // Verify it actually works before saving anywhere.
  const accounts = await verify(token);
  console.log(`\n✓ Token verified — pulled ${accounts.length} accounts from Monarch.`);

  updatePlistToken(token);
  updateRailway(token);

  console.log('\nDone. The daily Mac sync and the Railway server now use the fresh token.');
}

main().catch((err) => {
  console.error('\n✗ Reconnect failed:', err.message);
  process.exit(1);
});
