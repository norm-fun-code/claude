// Startup config validation (src/config/checkEnv.js) — see the engineering
// review's #10.
const test = require('node:test');
const assert = require('node:assert/strict');

const ENV_KEYS = ['NODE_ENV', 'DATABASE_URL', 'LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'NORMOS_API_TOKEN'];
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

test('validateBootConfig: does NOT exit when NODE_ENV=production and DATABASE_URL IS set', () => {
  const { mod, restore } = freshEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x', ANTHROPIC_API_KEY: 'x', NORMOS_API_TOKEN: 'tok' });
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
