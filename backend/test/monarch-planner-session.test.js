// The Monarch session the family planner reads.
//
// The planner has no Monarch login — it can only hold copies of a session, and this source
// row is the one place a working one reaches it. The connector used to cache a token only
// when it had to MINT one, so a NormOS running on its own MONARCH_TOKEN never signed in,
// never minted, and never published: it shared balances with the planner and never a
// credential. The planner's copy then expired with nothing coming to replace it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

// Load the connector with its Monarch and database edges replaced, so the test exercises the
// real decision and nothing reaches the network.
function loadConnector({ envToken, cachedToken, live = [] }) {
  const dir = path.join(__dirname, '..', 'src', 'connectors');
  const api = path.join(dir, '..', 'services', 'monarch-api.js');
  const snap = path.join(dir, '..', 'services', 'monarch-planner-snapshot.js');
  const sources = path.join(dir, '..', 'store', 'sources.js');
  const target = path.join(dir, 'monarch-api.js');

  const accounts = [{ id: '1', displayName: 'Checking', currentBalance: 10 }];
  const unauthorised = () => Object.assign(new Error('401'), { response: { status: 401 } });
  const calls = { logins: 0, published: [] };

  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    const resolved = (() => { try { return Module._resolveFilename(request, parent); } catch { return request; } })();
    if (resolved === api) return {
      login: async () => { calls.logins++; return 'minted'; },
      getAccounts: async (t) => { if (!live.includes(t)) throw unauthorised(); return accounts; },
      getTransactions: async (t) => { if (!live.includes(t)) throw unauthorised(); return []; },
    };
    if (resolved === snap) return { makeSnapshot: () => null, publishSnapshot: async (s) => { calls.published.push(s); } };
    if (resolved === sources) return { registerSource: async () => {} };
    return orig.apply(this, arguments);
  };
  delete require.cache[target];
  let connector;
  try { connector = require(target); } finally { Module._load = orig; delete require.cache[target]; }

  const prevToken = process.env.MONARCH_TOKEN, prevEmail = process.env.MONARCH_EMAIL, prevPass = process.env.MONARCH_PASSWORD;
  const restore = () => {
    for (const [k, v] of [['MONARCH_TOKEN', prevToken], ['MONARCH_EMAIL', prevEmail], ['MONARCH_PASSWORD', prevPass]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  if (envToken === undefined) delete process.env.MONARCH_TOKEN; else process.env.MONARCH_TOKEN = envToken;
  process.env.MONARCH_EMAIL = 'norm@example.com';
  process.env.MONARCH_PASSWORD = 'pw';

  return {
    calls, restore,
    sync: () => connector.sync({ lastSyncAt: null, config: cachedToken ? { monarchToken: cachedToken } : {} }),
  };
}

test('publishes the working session even when it was never minted here', async () => {
  // The reported case: NormOS syncing happily on its own MONARCH_TOKEN, planner locked out.
  const c = loadConnector({ envToken: 'env-token', live: ['env-token'] });
  try {
    const out = await c.sync();
    assert.equal(c.calls.logins, 0, 'no sign-in needed — that is the whole point of the env token');
    assert.equal(out.config.monarchToken, 'env-token', 'and the planner can now read it');
  } finally { c.restore(); }
});

test('publishes a freshly minted session, as it always did', async () => {
  const c = loadConnector({ envToken: undefined, live: ['minted'] });
  try {
    const out = await c.sync();
    assert.equal(c.calls.logins, 1);
    assert.equal(out.config.monarchToken, 'minted');
  } finally { c.restore(); }
});

test('publishes the session that survived a re-login, never the one Monarch rejected', async () => {
  const c = loadConnector({ envToken: undefined, cachedToken: 'expired', live: ['minted'] });
  try {
    const out = await c.sync();
    assert.equal(c.calls.logins, 1, 'the cached one was tried first and 401d');
    assert.equal(out.config.monarchToken, 'minted');
  } finally { c.restore(); }
});

test('preserves the rest of the source config rather than replacing it', async () => {
  const c = loadConnector({ envToken: 'env-token', live: ['env-token'] });
  try {
    const out = await c.sync({});
    assert.equal(out.config.monarchToken, 'env-token');
  } finally { c.restore(); }
});

test('stays dormant, and publishes nothing, when Monarch is not configured at all', async () => {
  const c = loadConnector({ envToken: undefined, live: [] });
  try {
    delete process.env.MONARCH_EMAIL;
    delete process.env.MONARCH_PASSWORD;
    const out = await c.sync();
    assert.deepEqual(out, { metrics: [], documents: [] });
    assert.equal(out.config, undefined);
  } finally { c.restore(); }
});
