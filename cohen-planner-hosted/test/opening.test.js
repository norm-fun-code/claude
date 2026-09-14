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

// A case is a set of ASSUMPTIONS. What you own today is not an assumption, and freezing it
// into a case makes the case project from whatever you held the day you saved it — which is
// how "Conservative" came to show 2026 ending BELOW today, months after Stripe equity had
// appeared in the accounts.
describe('a saved case keeps assumptions, not balances', () => {
  const live = { startingLiquid: 682000, startingStripeEquity: 614000, k401Start: 298000,
    otherDebt: 0, observedOn: '2026-09-13' };

  it('drops every opening balance on the way into a case', () => {
    const saved = O.stripObserved({ name: 'Conservative', investReturn: 0.04,
      startingLiquid: 1100000, startingStripeEquity: 0, k401Start: 210000, otherDebt: 0,
      observedOn: '2026-01-01' });
    for (const k of [...O.VALUE_KEYS, 'observedOn']) expect(saved, k).not.toHaveProperty(k);
    expect(saved).toEqual({ name: 'Conservative', investReturn: 0.04 });
  });

  it('re-attaches today\'s balances on the way out', () => {
    const loaded = O.withObserved({ name: 'Conservative', investReturn: 0.04 }, live);
    for (const k of O.VALUE_KEYS) expect(loaded[k], k).toBe(live[k]);
    expect(loaded.observedOn).toBe('2026-09-13');
    expect(loaded.investReturn).toBe(0.04);      // the assumption survives
  });

  it('heals a legacy case that still has balances baked in', () => {
    // Existing saved cases predate this rule. Loading overwrites what they carry rather
    // than trusting it, so they correct themselves without anyone re-saving.
    const legacy = { investReturn: 0.04, startingLiquid: 1100000, startingStripeEquity: 0 };
    const loaded = O.withObserved(legacy, live);
    expect(loaded.startingLiquid).toBe(682000);
    expect(loaded.startingStripeEquity).toBe(614000);
  });

  it('KEEPS a figure the reader set by hand, because that IS an assumption', () => {
    // "Set by hand" exists so a case can ask "what if my Stripe were twice this". Stripping
    // it would delete the only thing that made the case interesting.
    const whatIf = { investReturn: 0.04, startingStripeEquity: 1200000,
      openingSource: { startingStripeEquity: 'manual' } };
    const saved = O.stripObserved(whatIf);
    expect(saved.startingStripeEquity).toBe(1200000);
    expect(saved.openingSource).toEqual({ startingStripeEquity: 'manual' });
    // …and it is not overwritten when the case is loaded.
    const loaded = O.withObserved(saved, live);
    expect(loaded.startingStripeEquity).toBe(1200000);
    expect(loaded.startingLiquid).toBe(682000);   // its neighbours still follow
  });

  it('drops an empty openingSource rather than storing a husk', () => {
    expect(O.stripObserved({ investReturn: 0.04, openingSource: {} })).not.toHaveProperty('openingSource');
  });

  it('leaves a case alone when there is no live observation to attach', () => {
    const only = { investReturn: 0.04 };
    expect(O.withObserved(only, {})).toEqual(only);
    expect(O.withObserved(only, null)).toEqual(only);
  });

  it('never mutates what it is given', () => {
    const src = { investReturn: 0.04, startingLiquid: 1100000 };
    const before = JSON.stringify(src);
    O.stripObserved(src); O.withObserved(src, live);
    expect(JSON.stringify(src)).toBe(before);
  });
});

describe('the app routes every case through that rule', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  it('strips on save and on update', () => {
    expect(html).toContain('params:keepAssumptions({...P})');
    expect(html).toContain('scenarios[i].params=keepAssumptions({...P});');
    // …and both degrade rather than throw if the module is missing.
    expect(html).toContain('return window.PlannerOpening?PlannerOpening.stripObserved(params):params;');
  });

  it('re-attaches on load', () => {
    expect(html).toContain('migrateP(attachObserved(scenarios[i].params))');
    expect(html).toContain('PlannerOpening.withObserved(params,openingFromLivePlan()):params;');
  });

  it('projects every saved case through one helper', () => {
    // Rehydrate, the comparison table, the metric list and the diff all ran their own
    // `run({...D,...migrateP(s.params)})`, each free to drift onto a different basis.
    expect(html).not.toContain('migrateP(s.params)');
    expect((html.match(/scenarioPlan\(/g) || []).length).toBeGreaterThanOrEqual(5);
  });

  it('recomputes stored case results when the balances move', () => {
    // A case's results are a projection FROM today's balances and go stale the moment they
    // change; a comparison drawn from stale results is a comparison of two different days.
    expect(html).toContain('function rebuildScenarioResults()');
    const sync = html.slice(html.indexOf('function syncOpeningFromAccounts'), html.indexOf('async function takeWealthSnapshot'));
    expect(sync).toContain('rebuildScenarioResults();');
  });

  it('re-reads the accounts after a reset or an import', () => {
    // Both replace the whole plan, and neither used to re-sync — so a reset projected your
    // real balance sheet as though it were the sample one.
    const reset = html.slice(html.indexOf('async function resetAll'), html.indexOf('async function resetAll') + 500);
    expect(reset).toContain('syncOpeningFromAccounts();');
    expect(html.slice(html.indexOf('function importJSON'), html.indexOf('function importJSON') + 900))
      .toContain('syncOpeningFromAccounts();');
  });
});
