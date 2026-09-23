import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const root = new URL('../', import.meta.url);
const server = fs.readFileSync(new URL('server.js', root), 'utf8');
const html = fs.readFileSync(new URL('public/index.html', root), 'utf8');
const realD = vm.runInNewContext('(' + html.match(/const D=(\{[\s\S]*?\n\});/)[1] + ')');

// Build the demo page exactly as the server does, by running the server's own code — not a
// reimplementation of it, which would let the two drift and pass anyway.
function buildDemoPage(source = server) {
  const body = source.slice(source.indexOf('const DEMO_OVERRIDES'), source.indexOf('buildDemoPage();') + 16);
  const ctx = { fs, vm, path, console: { error() {} }, __dirname: new URL('.', root).pathname,
    Math, Object, String, JSON, Error };
  vm.createContext(ctx);
  vm.runInContext(body + '\nglobalThis.__page=demoPage;globalThis.__err=demoPageError;', ctx);
  return { page: ctx.__page, error: ctx.__err };
}

// Every figure in the default plan worth protecting. $3,000 is the line: above it these are
// balances, salaries and annual budgets; below it they are ages, rates, counts and years.
const MONEY = Object.entries(realD).filter(([, v]) => typeof v === 'number' && Math.abs(v) > 3000);

// ── The page a stranger receives ────────────────────────────────────────────
// Demo Mode already swapped in a fictional household and blocked every network read, so
// nothing private could be DRAWN. That was never the question for a shared link. index.html
// carries the plan's fallback defaults in its own source — a starting liquid balance, a
// salary, a rent, fifty-one figures in all — and View Source does not care what the UI drew.
describe('the shared demo page carries no real figures', () => {
  const { page } = buildDemoPage();

  it('is built at all', () => {
    expect(page).toBeTruthy();
    expect(MONEY.length).toBeGreaterThan(40);   // the thing being protected still exists
  });

  it('replaces every money figure in the default plan', () => {
    const demoD = JSON.parse(page.match(/const D=(\{.*?\});/)[1]);
    const kept = MONEY.filter(([k, v]) => demoD[k] === v);
    expect(kept.map(([k]) => k)).toEqual([]);
  });

  it('keeps the plan structurally whole, so the demo is a working app', () => {
    const demoD = JSON.parse(page.match(/const D=(\{.*?\});/)[1]);
    expect(Object.keys(demoD).sort()).toEqual(Object.keys(realD).sort());
    for (const [k, v] of Object.entries(realD))
      if (typeof v !== 'number') expect(demoD[k]).toEqual(v);
  });

  it('boots straight into demo mode, before anything can be fetched', () => {
    expect(page).toContain('window.__SHARED_DEMO__=1');
    expect(html).toContain('if(window.__SHARED_DEMO__){');
    expect(html).toContain('enterDemoMode({shared:true});');
  });
});

// ── Fail closed ─────────────────────────────────────────────────────────────
// A demo page that could not be sanitised is the real page, and the real page is the one
// thing this route must never serve.
describe('when it cannot be sanitised it serves nothing', () => {
  it('refuses when the default plan block cannot be found', () => {
    const broken = server.replace('const m = src.match(/const D=(\\{[\\s\\S]*?\\n\\});/);',
      'const m = null;');
    const { page, error } = buildDemoPage(broken);
    expect(page).toBeFalsy();
    expect(error).toMatch(/not found/);
  });

  it('refuses when any money figure survives the swap', () => {
    // The guard that caught a demo value which happened to equal the real one.
    // Replace the demo's own value, rather than prepending a duplicate key — in an object
    // literal the later one wins, so a prepended override does nothing at all.
    const leaky = server.replace('startingLiquid: 725000,', `startingLiquid: ${realD.startingLiquid},`);
    expect(leaky).not.toBe(server);
    const { page, error } = buildDemoPage(leaky);
    expect(page).toBeFalsy();
    expect(error).toMatch(/startingLiquid was not replaced/);
  });

  it('answers 503 rather than falling back to the real page', () => {
    expect(server).toContain("if (!demoPage) return res.status(503)");
    const route = server.slice(server.indexOf("app.get('/demo'"), server.indexOf("function requireAuthOrDemo"));
    expect(route).not.toContain('sendFile');
  });
});

// ── The class of bug that made this necessary ───────────────────────────────
// A default repeated as a literal somewhere else in the file survives a rewrite of the
// default. `P.k401Start||210000` put a real 401(k) balance in the demo page's source, under
// the label "starting balance", however carefully the plan block itself was swapped.
describe('no default is duplicated as a magic number', () => {
  it('has no money-valued fallback literal in the page', () => {
    const fallbacks = [...html.matchAll(/(?:\?\?|\|\|)(\d{4,})/g)].map(m => Number(m[1]));
    const money = fallbacks.filter(n => n > 3000 && n !== 2026 && n !== 2058);
    expect(money).toEqual([]);
  });

  it('points those fallbacks at the default plan instead', () => {
    // So the sanitiser reaches them, and there is one source of truth either way.
    expect(html).toContain('P.k401Start||D.k401Start');
    expect(html).toContain('liquidReserveFloor??D.liquidReserveFloor');
    expect(html).toContain('P.normCashY10??D.normCashY10');
    expect(html).toContain('(P.maintBase||D.maintBase)');
  });

  it('leaves nothing in the served page that names a real figure', () => {
    // The remaining numeric coincidences are slider bounds, stress labels, timeouts and the
    // demo household's own values. None of them sits next to a key naming a real one.
    const { page } = buildDemoPage();
    for (const [k, v] of MONEY) {
      const near = new RegExp(`["']?${k}["']?\\s*[:=]\\s*${Math.abs(v)}(?![0-9])`);
      expect(page).not.toMatch(near);
    }
  });
});

// ── Finding it ──────────────────────────────────────────────────────────────
describe('the way in', () => {
  it('is a link on the login page, not a second sign-in path', () => {
    // There is nothing here to authenticate: /demo holds no data, so a password field or a
    // shared secret would be ceremony protecting nothing.
    const login = server.slice(server.indexOf("app.get('/login'"), server.indexOf("app.post('/login'"));
    expect(login).toContain('<a href="/demo">Open the demo →</a>');
    expect(login).toContain('No sign-in. Invented numbers.');
    expect(login).toContain('.demo-line{');
  });
});

// ── What the link may reach ─────────────────────────────────────────────────
describe('a demo visitor gets the app and nothing else', () => {
  it('is let through to static assets, which are code and not data', () => {
    expect(server).toContain('function requireAuthOrDemo(req, res, next) {');
    expect(server).toContain('if (req.session && (req.session.authenticated || req.session.demo)) return next();');
    expect(server).toContain("app.get('/' + asset, requireAuthOrDemo,");
    expect(server).toContain("app.get('/model.js', requireAuthOrDemo,");
  });

  it('is never marked authenticated, so every API route still refuses it', () => {
    const route = server.slice(server.indexOf("app.get('/demo'"), server.indexOf('function requireAuthOrDemo'));
    expect(route).toContain('req.session.demo = true');
    expect(route).not.toMatch(/session\.authenticated\s*=/);
    // The real page and the data behind it keep the gate they had.
    expect(server).toContain("app.get('/', requireAuth, (req, res) => {");
    expect(server).not.toMatch(/app\.(get|post)\('\/api\/[^']*',\s*requireAuthOrDemo/);
  });

  it('cannot write anything back', () => {
    // Three independent reasons, because a public page writing to the owner's plan is the
    // worst failure available here: the server refuses an unauthenticated write, the save
    // returns early in demo mode, and in the shared demo the save is replaced outright.
    expect(html).toContain("if(typeof _demoMode!=='undefined'&&_demoMode)return;");
    expect(html).toContain('savePlannerState=()=>{};');
    expect(server).toContain("app.put('/api/planner-state', requireAuth");
  });

  it('is not offered an exit that would land on a login page', () => {
    expect(html).toContain('_sharedDemo=!!(opts&&opts.shared);');
    expect(html).toMatch(/_sharedDemo\s*\?\s*'<div class="demo-banner"[^']*invented/);
    expect(html).toContain("for(const sel of ['.logout-btn','#monarchSyncBtn','#monarchConnectBtn','#monarchFreshness','.sync-pill'])");
  });
});
