// Regression test for util/env.js's envInt — the exact bug this closes:
// `Number(process.env.X) || fallback` silently discards a legitimately-zero
// config value (e.g. SCHEDULE_HOUR=0 for midnight) in favor of the default,
// because `0 || fallback` is always `fallback` in JS. This bug made
// routes/briefing.js's pastMorningCutoff() (and scheduler.js's startJobs(),
// and diagnostics.js's /diag/scheduler) silently ignore SCHEDULE_HOUR=0 /
// SCHEDULE_MINUTE=0, which is exactly the fixture briefing-self-heal.test.js
// uses to force a deterministic "past cutoff" — the test failed nondeterministically
// depending on the real wall-clock hour until this was fixed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { envInt } = require('../src/util/env');

function withEnv(name, value, fn) {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

test('required: envInt returns 0 when the env var is explicitly "0" — never falls back to the default', () => {
  withEnv('TEST_ENV_INT_VAR', '0', () => {
    assert.equal(envInt('TEST_ENV_INT_VAR', 8), 0);
  });
});

test('required: envInt falls back to the default when the var is unset', () => {
  withEnv('TEST_ENV_INT_VAR', undefined, () => {
    assert.equal(envInt('TEST_ENV_INT_VAR', 8), 8);
  });
});

test('required: envInt falls back to the default when the var is an empty string', () => {
  withEnv('TEST_ENV_INT_VAR', '', () => {
    assert.equal(envInt('TEST_ENV_INT_VAR', 8), 8);
  });
});

test('required: envInt falls back to the default when the var is not a finite number', () => {
  withEnv('TEST_ENV_INT_VAR', 'not-a-number', () => {
    assert.equal(envInt('TEST_ENV_INT_VAR', 8), 8);
  });
});

test('required: envInt returns the parsed value for an ordinary non-zero setting', () => {
  withEnv('TEST_ENV_INT_VAR', '15', () => {
    assert.equal(envInt('TEST_ENV_INT_VAR', 8), 15);
  });
});
