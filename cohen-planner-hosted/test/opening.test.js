import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const O = require('../public/opening.js');
const A = require('../public/accounts.js');

const accounts = [
  { id: '1', name: 'Chase Checking', category: 'cash', balance: 180000 },
  { id: '2', name: 'Fidelity Brokerage', category: 'investment', balance: 520000 },
  { id: '3', name: 'Stripe Equity', category: 'other_asset', balance: 614000 },
  { id: '4', name: 'Stripe 401(k)', category: 'retirement', balance: 240000 },
  { id: '5', name: 'Amex', category: 'liability', balance: -9000 },
];
const sum = (accts = accounts, ov = {}) => A.summarize(accts, ov);
const P = { startingLiquid: 1100000, startingStripeEquity: 0, k401Start: 210000, otherDebt: 0 };
const row = (r, k) => r.rows.find(x => x.key === k);

// Two copies of one fact means one of them is always wrong. The opening figures follow the
// accounts — the whole question is when they must refuse to.
describe('opening balances follow the accounts', () => {
  it('takes every figure from what the accounts actually hold', () => {
    const r = O.syncOpening(P, sum(), true);
    expect(r.P.startingLiquid).toBe(700000);        // cash + taxable
    expect(r.P.startingStripeEquity).toBe(614000);  // vested Stripe only
    expect(r.P.k401Start).toBe(240000);             // including the Stripe 401(k)
    expect(r.P.otherDebt).toBe(9000);               // as a positive carried balance
  });

  it('never mutates the plan it was handed', () => {
    const before = JSON.stringify(P);
    O.syncOpening(P, sum(), true);
    expect(JSON.stringify(P)).toBe(before);
  });

  it('reports nothing to do once the plan already matches', () => {
    const synced = O.syncOpening(P, sum(), true).P;
    const again = O.syncOpening(synced, sum(), true);
    expect(again.changed).toEqual([]);
    expect(again.dirty).toBe(false);
  });

  it('keeps a Stripe 401(k) out of the Stripe equity figure', () => {
    // The classic misclassification: retirement money at the same employer is not company
    // stock, and folding it in would double the apparent concentration.
    const r = O.syncOpening(P, sum(), true);
    expect(r.P.startingStripeEquity).toBe(614000);
    expect(r.P.k401Start).toBe(240000);
  });
});

describe('when it must NOT follow', () => {
  it('holds the last value when accounts are unreachable', () => {
    const r = O.syncOpening(P, sum(), false);
    expect(r.P).toEqual(P);                         // nothing written at all
    expect(r.held.map(h => h.key)).toContain('startingLiquid');
    expect(row(r, 'startingLiquid').reason).toMatch(/unavailable/);
  });

  it('holds when a balance could not be read, rather than following a short total', () => {
    const gappy = [...accounts, { id: '9', name: 'Dead broker', category: 'investment' }];
    const r = O.syncOpening(P, sum(gappy), true);
    expect(r.P).toEqual(P);
    expect(row(r, 'startingLiquid').reason).toMatch(/short by an unknown amount/);
  });

  it('refuses a zero that is really an unclassified account', () => {
    // An empty bucket and an unclassified one both report zero. Only one of them should
    // ever overwrite a real plan figure.
    const noStripe = accounts.filter(a => a.id !== '3');
    const withPlan = { ...P, startingStripeEquity: 614000 };
    const r = O.syncOpening(withPlan, sum(noStripe), true);
    expect(r.P.startingStripeEquity).toBe(614000);  // untouched
    expect(row(r, 'startingStripeEquity').reason).toMatch(/gap in classification/);
  });

  it('does follow a genuine zero when an account backs it', () => {
    const emptied = accounts.map(a => a.id === '3' ? { ...a, balance: 0 } : a);
    const withPlan = { ...P, startingStripeEquity: 614000 };
    const r = O.syncOpening(withPlan, sum(emptied), true);
    expect(r.P.startingStripeEquity).toBe(0);       // observed, not inferred
  });

  it('never blanks a field it is holding', () => {
    for (const [s, avail] of [[sum(), false], [sum([...accounts, { id: '9', name: 'X', category: 'cash' }]), true]]) {
      const r = O.syncOpening(P, s, avail);
      for (const f of ['startingLiquid', 'startingStripeEquity', 'k401Start', 'otherDebt'])
        expect(r.P[f], f).toBe(P[f]);
    }
  });
});

describe('taking a figure back by hand', () => {
  it('stops tracking once set to manual, which is what makes a what-if possible', () => {
    const manual = O.setMode(P, 'startingStripeEquity', 'manual');
    const r = O.syncOpening({ ...manual, startingStripeEquity: 1200000 }, sum(), true);
    expect(r.P.startingStripeEquity).toBe(1200000);
    expect(row(r, 'startingStripeEquity').following).toBe(false);
    expect(row(r, 'startingStripeEquity').reason).toMatch(/set this one yourself/);
    // …while its neighbours carry on following.
    expect(r.P.k401Start).toBe(240000);
  });

  it('is not reported as held, because it is a choice rather than a failure', () => {
    const manual = O.setMode(P, 'k401Start', 'manual');
    expect(O.syncOpening(manual, sum(), true).held.map(h => h.key)).not.toContain('k401Start');
  });

  it('resumes tracking when handed back, without writing on the spot', () => {
    const off = O.setMode(P, 'k401Start', 'manual');
    const on = O.setMode(off, 'k401Start', 'auto');
    expect(on.openingSource.k401Start).toBeUndefined();
    expect(O.syncOpening(on, sum(), true).P.k401Start).toBe(240000);
  });

  it('ignores a field it does not own', () => {
    expect(O.setMode(P, 'homePrice', 'manual')).toBe(P);
  });
});

import fs from 'node:fs';
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

describe('the plan stops holding a second copy of the accounts', () => {
  it('loads the module and serves it', () => {
    expect(html).toContain('<script src="/opening.js">');
    expect(server).toContain("'opening.js'");
  });

  it('re-reads whenever a fresh account reading arrives', () => {
    const load = html.slice(html.indexOf('async function loadOverview'), html.indexOf('async function takeWealthSnapshot'));
    expect(load).toContain('syncOpeningFromAccounts();');
  });

  it('writes into the plan rather than overlaying at render time', () => {
    // One number on every screen, in every scenario and every saved snapshot. An overlay
    // would leave the stored plan and the displayed plan quietly different.
    const fn = html.slice(html.indexOf('function syncOpeningFromAccounts'), html.indexOf('async function takeWealthSnapshot'));
    expect(fn).toContain('P=out.P;');
    expect(fn).toContain('savePlannerState()');
    expect(fn).toContain('if(!out.dirty)return;');   // no save loop when nothing moved
  });

  it('says what changed instead of moving the numbers quietly', () => {
    const fn = html.slice(html.indexOf('function syncOpeningFromAccounts'), html.indexOf('async function takeWealthSnapshot'));
    expect(fn).toMatch(/Opening balances updated from your accounts/);
  });

  it('shows the source in the settings row, not an empty box', () => {
    const ui = html.slice(html.indexOf('const sLinked=key=>'), html.indexOf('const ST=(label,key,body)'));
    expect(ui).toContain('From your accounts');
    expect(ui).toContain('data-state="${manual?\'manual\':r.following?\'live\':\'held\'}"');
    // The reason a held field is held belongs beside the stale number it explains.
    expect(ui).toContain(':r.reason');
  });

  it('uses the linked row for every figure the accounts can supply', () => {
    for (const k of ['startingStripeEquity', 'startingLiquid', 'k401Start', 'otherDebt'])
      expect(html, k).toContain(`sLinked('${k}')`);
    // …and no longer offers the old free-typed box for the ones that now track.
    expect(html).not.toContain("sTxt('Existing Stripe equity','startingStripeEquity')");
    expect(html).not.toContain("s('Starting 401k','k401Start'");
  });

  it('can hand a figure back, which is what keeps what-ifs possible', () => {
    expect(html).toContain('function setOpeningMode(key,m)');
    expect(html).toContain("PlannerOpening.setMode(P,key,m)");
    expect(html).toContain('Set by hand');
    expect(html).toContain('Follow my accounts');
  });
});
