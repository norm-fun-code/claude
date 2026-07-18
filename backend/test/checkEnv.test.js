// Startup config validation (src/config/checkEnv.js) — see the engineering
// review's #10.
const test = require('node:test');
const assert = require('node:assert/strict');

const ENV_KEYS = ['NODE_ENV', 'DATABASE_URL', 'LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'NORMOS_API_TOKEN', 'NORMOS_ADMIN_TOKEN'];
function freshEnv(overrides) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, overrides);
  delete require.cache[require.resolve('../src/config/checkEnv')];
  return {
    mod: require('../src/config/checkEnv'),
    restore: () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } },
  };
}

test('hasChatLLM: true when ANTHROPIC_API_KEY is set (default provider)', () => {
  const { mod, restore } = freshEnv({ ANTHROPIC_API_KEY: 'x' });
  try { assert.equal(mod.hasChatLLM(), true); } finally { restore(); }
});

test('hasChatLLM: true when GEMINI_API_KEY is set and no Anthropic key', () => {
  const { mod, restore } = freshEnv({ GEMINI_API_KEY: 'x' });
  try { assert.equal(mod.hasChatLLM(), true); } finally { restore(); }
});

test('hasChatLLM: false when nothing is configured', () => {
  const { mod, restore } = freshEnv({});
  try { assert.equal(mod.hasChatLLM(), false); } finally { restore(); }
});

test('hasChatLLM: false when LLM_PROVIDER=gemini explicitly but no GEMINI_API_KEY, even with an Anthropic key set', () => {
  const { mod, restore } = freshEnv({ LLM_PROVIDER: 'gemini', ANTHROPIC_API_KEY: 'x' });
  try { assert.equal(mod.hasChatLLM(), false); } finally { restore(); }
});

test('validateBootConfig: exits the process when NODE_ENV=production and DATABASE_URL is unset', () => {
  const { mod, restore } = freshEnv({ NODE_ENV: 'production', ANTHROPIC_API_KEY: 'x' });
  const originalExit = process.exit;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error('__exit__'); };
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.throws(() => mod.validateBootConfig(), /__exit__/);
    assert.equal(exitCode, 1);
  } finally {
    process.exit = originalExit;
    console.error = originalError;
    restore();
  }
});

test('validateBootConfig: does NOT exit when NODE_ENV=production and DATABASE_URL/NORMOS_API_TOKEN/NORMOS_ADMIN_TOKEN are ALL set', () => {
  const { mod, restore } = freshEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', ANTHROPIC_API_KEY: 'x', NORMOS_API_TOKEN: 'tok', NORMOS_ADMIN_TOKEN: 'admintok' });
  const originalExit = process.exit;
  let called = false;
  process.exit = () => { called = true; };
  try {
    mod.validateBootConfig();
    assert.equal(called, false);
  } finally {
    process.exit = originalExit;
    restore();
  }
});

// ── Production Safety Gate (audit recommendation #1) ────────────────────────

test('validateBootConfig: exits when NODE_ENV=production and NORMOS_API_TOKEN is missing (DATABASE_URL/ADMIN_TOKEN set)', () => {
  const { mod, restore } = freshEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', ANTHROPIC_API_KEY: 'x', NORMOS_ADMIN_TOKEN: 'admintok' });
  const originalExit = process.exit;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error('__exit__'); };
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    assert.throws(() => mod.validateBootConfig(), /__exit__/);
    assert.equal(exitCode, 1);
    assert.ok(logged.some((l) => l.includes('NORMOS_API_TOKEN')), 'the missing var name must be named in the message');
  } finally {
    process.exit = originalExit;
    console.error = originalError;
    restore();
  }
});

test('validateBootConfig: exits when NODE_ENV=production and NORMOS_ADMIN_TOKEN is missing (DATABASE_URL/API_TOKEN set)', () => {
  const { mod, restore } = freshEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', ANTHROPIC_API_KEY: 'x', NORMOS_API_TOKEN: 'tok' });
  const originalExit = process.exit;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error('__exit__'); };
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    assert.throws(() => mod.validateBootConfig(), /__exit__/);
    assert.equal(exitCode, 1);
    assert.ok(logged.some((l) => l.includes('NORMOS_ADMIN_TOKEN')), 'the missing var name must be named in the message');
  } finally {
    process.exit = originalExit;
    console.error = originalError;
    restore();
  }
});

test('validateBootConfig: lists EVERY missing required var by name when several are absent at once', () => {
  const { mod, restore } = freshEnv({ NODE_ENV: 'production', ANTHROPIC_API_KEY: 'x' });
  const originalExit = process.exit;
  process.exit = (code) => { throw new Error(`__exit__${code}__`); };
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    assert.throws(() => mod.validateBootConfig(), /__exit__1__/);
    const combined = logged.join('\n');
    assert.match(combined, /DATABASE_URL/);
    assert.match(combined, /NORMOS_API_TOKEN/);
    assert.match(combined, /NORMOS_ADMIN_TOKEN/);
  } finally {
    process.exit = originalExit;
    console.error = originalError;
    restore();
  }
});

test('validateBootConfig: names the missing var but never prints an actual configured secret VALUE, even when a DIFFERENT required var is what triggers the fatal exit', () => {
  const FAKE_DATABASE_URL = 'postgres://realuser:s3cr3t-p4ssw0rd@prod-db.internal:5432/normos';
  const { mod, restore } = freshEnv({ NODE_ENV: 'production', DATABASE_URL: FAKE_DATABASE_URL, ANTHROPIC_API_KEY: 'x', NORMOS_ADMIN_TOKEN: 'super-secret-admin-token' });
  const originalExit = process.exit;
  process.exit = (code) => { throw new Error(`__exit__${code}__`); };
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    // Only NORMOS_API_TOKEN is missing here — DATABASE_URL and
    // NORMOS_ADMIN_TOKEN are both SET to realistic-looking secret values.
    // The fatal message must name NORMOS_API_TOKEN without ever echoing the
    // other two vars' actual values back into the log.
    assert.throws(() => mod.validateBootConfig(), /__exit__1__/);
    const combined = logged.join('\n');
    assert.match(combined, /NORMOS_API_TOKEN/);
    assert.doesNotMatch(combined, /s3cr3t-p4ssw0rd/, 'must never echo a configured DATABASE_URL value into the log');
    assert.doesNotMatch(combined, /super-secret-admin-token/, 'must never echo a configured NORMOS_ADMIN_TOKEN value into the log');
  } finally {
    process.exit = originalExit;
    console.error = originalError;
    restore();
  }
});

test('validateBootConfig: does NOT exit outside production even with no DATABASE_URL (local dev falls back fine)', () => {
  const { mod, restore } = freshEnv({ ANTHROPIC_API_KEY: 'x' });
  const originalExit = process.exit;
  let called = false;
  process.exit = () => { called = true; };
  try {
    mod.validateBootConfig();
    assert.equal(called, false);
  } finally {
    process.exit = originalExit;
    restore();
  }
});

test('validateBootConfig: warns (does not exit) when no chat LLM is configured', () => {
  const { mod, restore } = freshEnv({});
  const originalWarn = console.warn;
  const logs = [];
  console.warn = (...args) => logs.push(args.join(' '));
  try {
    mod.validateBootConfig();
    assert.ok(logs.some((l) => l.includes('No usable chat LLM')));
  } finally {
    console.warn = originalWarn;
    restore();
  }
});
