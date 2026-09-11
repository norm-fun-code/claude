import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const A = require('../public/accounts.js');
const { extractAccounts, readBalance, parseBalance } = require('../monarch-accounts.js');

const acct = (o) => ({ id: 'a1', name: 'Account', institution: '', category: '', balance: 1000, ...o });

// ── Classification ───────────────────────────────────────────────────────
describe('account classification', () => {
  it('classifies the ordinary cases from the provider category and name', () => {
    expect(A.classifyAccount(acct({ name: 'Chase Checking', category: 'cash' })).cls).toBe(A.CLASS.CASH);
    expect(A.classifyAccount(acct({ name: 'Fidelity Brokerage', category: 'investment' })).cls).toBe(A.CLASS.TAXABLE);
    expect(A.classifyAccount(acct({ name: 'Amex', category: 'liability', balance: -800 })).cls).toBe(A.CLASS.DEBT);
  });

  it('does NOT classify a Stripe 401(k) as Stripe company stock', () => {
    // The trap: a name-based "Stripe" rule would file retirement money as concentrated
    // private equity in the same employer, overstating concentration and misstating access.
    const c = A.classifyAccount(acct({ name: 'Stripe 401(k)', institution: 'Fidelity', category: 'retirement' }));
    expect(c.cls).toBe(A.CLASS.RETIREMENT);
    expect(c.stripeKind).toBeNull();
    expect(c.reason).toMatch(/not company stock/i);
  });

  it('still classifies vested Stripe equity as a private holding', () => {
    const c = A.classifyAccount(acct({ name: 'Stripe Equity', institution: 'Stripe', category: 'investment' }));
    expect(c.cls).toBe(A.CLASS.PRIVATE);
    expect(c.stripeKind).toBe('vested');
  });

  it('retirement wins over every Stripe rule regardless of wording', () => {
    for (const name of ['Stripe Roth IRA', 'Stripe retirement plan', 'Stripe 403(b)']) {
      const c = A.classifyAccount(acct({ name }));
      expect(c.cls).toBe(A.CLASS.RETIREMENT);
      expect(c.stripeKind).toBeNull();
    }
  });

  it('keys on the stable id, so a rename cannot silently reclassify', () => {
    const overrides = { a1: { class: A.CLASS.PRIVATE, note: 'set by you' } };
    const before = A.classifyAccount(acct({ id: 'a1', name: 'Coinbase' }), overrides);
    const after = A.classifyAccount(acct({ id: 'a1', name: 'Something Else Entirely' }), overrides);
    expect(before.cls).toBe(A.CLASS.PRIVATE);
    expect(after.cls).toBe(before.cls);
    expect(after.source).toBe(A.SOURCE.USER);
  });

  it('says unknown rather than guessing', () => {
    const c = A.classifyAccount(acct({ name: 'Zzz Holdings', category: 'other' }));
    expect(c.cls).toBe(A.CLASS.UNKNOWN);
    expect(c.reason).toMatch(/classify it/i);
  });
});

// ── Accessible vs. wealth ────────────────────────────────────────────────
describe('accessible assets', () => {
  const accounts = [
    acct({ id: '1', name: 'Chase Checking', category: 'cash', balance: 60000 }),
    acct({ id: '2', name: 'Fidelity Brokerage', category: 'investment', balance: 509000 }),
    acct({ id: '3', name: 'Stripe 401(k)', category: 'retirement', balance: 210000 }),
    acct({ id: '4', name: 'Stripe Equity', institution: 'Stripe', category: 'investment', balance: 425000 }),
    acct({ id: '5', name: 'Amex', category: 'liability', balance: -8000 }),
  ];
  it('separates what can be spent from what is merely owned', () => {
    const s = A.summarize(accounts, {});
    expect(s.accessible).toBe(569000);          // cash + taxable only
    expect(s.stripeVested).toBe(425000);        // private, not accessible
    expect(s.byClass[A.CLASS.RETIREMENT].total).toBe(210000);
    expect(s.netWorth).toBe(60000 + 509000 + 210000 + 425000 - 8000);
    expect(s.debt).toBe(8000);
  });
  it('does not fold retirement or private holdings into accessible', () => {
    const s = A.summarize(accounts, {});
    expect(s.accessible).toBeLessThan(s.netWorth);
  });
});

// ── Missing balances and the confirmed override ──────────────────────────
describe('missing balances', () => {
  it('a missing balance is unknown, not zero', () => {
    const s = A.summarize([acct({ id: 'cb', name: 'Coinbase', balance: null, rawBalance: undefined })], {});
    expect(s.unknownBalance).toHaveLength(1);
    expect(s.complete).toBe(false);
    expect(s.assets).toBe(0); // excluded entirely rather than counted as 0
  });

  it('a dated per-account confirmation supplies the value and keeps the provenance', () => {
    const ov = { cb: { balance: 0, confirmedAt: '2026-09-10T12:00:00Z', note: 'confirmed empty' } };
    const b = A.resolveBalance(acct({ id: 'cb', name: 'Coinbase', balance: null, rawBalance: undefined }), ov);
    expect(b.value).toBe(0);
    expect(b.missing).toBe(false);
    expect(b.source).toBe(A.SOURCE.USER);       // never presented as an observation
    expect(b.asOf).toBe('2026-09-10T12:00:00Z');
    expect(b.rawMissing).toBeNull();            // what the provider returned is preserved
  });

  it('the confirmation applies ONLY to the account it names', () => {
    const ov = { cb: { balance: 0, confirmedAt: '2026-09-10T12:00:00Z' } };
    const s = A.summarize([
      acct({ id: 'cb', name: 'Coinbase', balance: null }),
      acct({ id: 'other', name: 'Other Brokerage', category: 'investment', balance: null }),
    ], ov);
    expect(s.unknownBalance.map(a => a.id)).toEqual(['other']); // not converted to zero
    expect(s.complete).toBe(false);
  });

  it('a newer provider balance supersedes the confirmation', () => {
    const ov = { cb: { balance: 0, confirmedAt: '2026-09-10T12:00:00Z' } };
    const b = A.resolveBalance(acct({ id: 'cb', name: 'Coinbase', balance: 1234, asOf: '2026-10-01' }), ov);
    expect(b.value).toBe(1234);
    expect(b.source).toBe(A.SOURCE.PROVIDER);
    expect(b.supersededOverride).toBe(true);
    expect(b.note).toMatch(/no longer used/i);
  });
});

// ── The snapshot gate ────────────────────────────────────────────────────
describe('snapshot rejection', () => {
  const resp = (accounts) => ({ result: { structuredContent: { accounts } } });

  it('still rejects a snapshot with an unexplained missing balance', () => {
    expect(() => extractAccounts(resp([{ id: '1', currentBalance: 100 }, { id: '2', currentBalance: null }])))
      .toThrow(/without a readable balance/i);
  });

  it('accepts it once the specific account is confirmed', () => {
    const out = extractAccounts(resp([{ id: '1', currentBalance: 100 }, { id: 'cb', currentBalance: null }]),
      { cb: { balance: 0, confirmedAt: '2026-09-10T12:00:00Z' } });
    expect(out).toHaveLength(2);
  });

  it('a confirmation for one account does not rescue a different one', () => {
    expect(() => extractAccounts(resp([{ id: 'cb', currentBalance: null }, { id: 'zz', currentBalance: null }]),
      { cb: { balance: 0 } })).toThrow(/without a readable balance/i);
  });

  it('readBalance still refuses a non-numeric confirmation', () => {
    expect(() => readBalance({ id: 'cb', currentBalance: null }, { cb: { balance: 'lots' } })).toThrow();
    expect(parseBalance('$1,234.50')).toBe(1234.5);
    expect(parseBalance('N/A')).toBeNull();
  });
});

// ── Reconciliation ───────────────────────────────────────────────────────
describe('reconciliation', () => {
  const accounts = [
    acct({ id: '1', name: 'Chase Checking', category: 'cash', balance: 60000 }),
    acct({ id: '2', name: 'Fidelity Brokerage', category: 'investment', balance: 509000 }),
    acct({ id: '3', name: 'Stripe 401(k)', category: 'retirement', balance: 210000 }),
    acct({ id: '4', name: 'Stripe Equity', institution: 'Stripe', category: 'investment', balance: 425000 }),
  ];
  const P = { startingLiquid: 675000, startingStripeEquity: 425000, k401Start: 210000 };

  it('proposes rather than applies, and labels both sides', () => {
    const r = A.reconcile(A.summarize(accounts, {}), P);
    const liquid = r.lines.find(l => l.key === 'startingLiquid');
    expect(liquid.planValue).toBe(675000);
    expect(liquid.actual).toBe(569000);
    expect(liquid.delta).toBe(-106000);
    expect(liquid.planSource).toBe(A.SOURCE.MODEL);
    expect(liquid.actualSource).toBe(A.SOURCE.PROVIDER);
    // nothing in the return applies anything
    expect(Object.keys(r)).toEqual(expect.arrayContaining(['lines', 'complete', 'blocked']));
  });

  it('compares Stripe equity against vested holdings only', () => {
    const r = A.reconcile(A.summarize(accounts, {}), P);
    expect(r.lines.find(l => l.key === 'startingStripeEquity').delta).toBe(0);
  });

  it('counts a Stripe 401(k) toward retirement, not Stripe equity', () => {
    const r = A.reconcile(A.summarize(accounts, {}), P);
    expect(r.lines.find(l => l.key === 'k401Start').actual).toBe(210000);
    expect(r.lines.find(l => l.key === 'startingStripeEquity').actual).toBe(425000);
  });

  it('flags itself incomplete while any balance is unknown', () => {
    const r = A.reconcile(A.summarize([...accounts, acct({ id: 'x', name: 'Mystery', balance: null })], {}), P);
    expect(r.complete).toBe(false);
    expect(r.blocked).toContain('Mystery');
  });
});

// ── Double counting ──────────────────────────────────────────────────────
describe('double counting', () => {
  it('spots holdings that ARE an account balance rather than extra wealth', () => {
    const issues = A.detectDoubleCounting(
      [acct({ id: '2', name: 'Fidelity Brokerage', balance: 509000 })],
      [{ ticker: 'FXAIX', value: 347000 }, { ticker: 'MU', value: 162000 }]); // sums to 509000
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/one or the other/i);
  });

  it('stays quiet when holdings genuinely belong to a different account', () => {
    expect(A.detectDoubleCounting([acct({ id: '1', balance: 60000 })], [{ value: 509000 }])).toHaveLength(0);
    expect(A.detectDoubleCounting([acct({ id: '1', balance: 60000 })], [])).toHaveLength(0);
  });
});

// ── Capabilities ─────────────────────────────────────────────────────────
describe('capabilities', () => {
  it('tracks each data type separately', () => {
    const c = A.capabilities({ balances: true, holdings: false, transactions: true });
    expect(c.balances.available).toBe(true);
    expect(c.holdings.available).toBe(false);
    expect(c.transactions.available).toBe(true);
  });

  it('reports tax lots as unavailable by design, not as a retryable failure', () => {
    const c = A.capabilities({ balances: true, holdings: true, transactions: true, taxLots: true });
    expect(c.taxLots.available).toBe(false); // cannot be forced true
    expect(c.taxLots.detail).toMatch(/not exposed by Monarch/i);
  });

  it('disables only the dependent analysis', () => {
    const blocked = A.blockedBy(A.capabilities({ balances: true, holdings: false, transactions: true }));
    const needs = blocked.map(b => b.needs);
    expect(needs).toContain('holdings');
    expect(needs).toContain('taxLots');
    expect(needs).not.toContain('transactions'); // available, so nothing about it is blocked
  });
});

// ── Absence of classification must not erase a plan value ────────────────
describe('reconciliation refuses to apply a zero it cannot back', () => {
  const P = { startingLiquid: 693000, startingStripeEquity: 614000, k401Start: 300000 };
  // The real case: a Stripe equity account exists but is named something the rules do not
  // recognise, so it classifies as taxable. Stripe equity then reads $0 — not because the
  // money is gone, but because nothing was classified into that bucket.
  const accounts = [
    acct({ id: '1', name: 'Chase Checking', category: 'cash', balance: 60000 }),
    acct({ id: '2', name: 'Shareworks', category: 'investment', balance: 614000 }), // really Stripe
    acct({ id: '3', name: 'Fidelity 401k', category: 'retirement', balance: 300000 }),
  ];

  it('marks the Stripe line inapplicable rather than offering to zero it', () => {
    const r = A.reconcile(A.summarize(accounts, {}), P);
    const stripe = r.lines.find(l => l.key === 'startingStripeEquity');
    expect(stripe.actual).toBe(0);
    expect(stripe.applicable).toBe(false);              // Apply must not be offered
    expect(stripe.accountsBacking).toBe(0);
    expect(stripe.blockedReason).toMatch(/classification/i);
  });

  it('becomes applicable once the account is marked as vested Stripe', () => {
    const overrides = { 2: { class: A.CLASS.PRIVATE, stripeKind: 'vested' } };
    const r = A.reconcile(A.summarize(accounts, overrides), P);
    const stripe = r.lines.find(l => l.key === 'startingStripeEquity');
    expect(stripe.actual).toBe(614000);
    expect(stripe.applicable).toBe(true);
    expect(stripe.delta).toBe(0);                      // and it now matches the plan
  });

  it('stops counting that money as accessible once it is marked private', () => {
    const before = A.summarize(accounts, {});
    const after = A.summarize(accounts, { 2: { class: A.CLASS.PRIVATE, stripeKind: 'vested' } });
    expect(before.accessible).toBe(674000);            // Stripe wrongly counted as spendable
    expect(after.accessible).toBe(60000);              // …corrected
    expect(after.netWorth).toBe(before.netWorth);      // net worth unchanged — only access
  });

  it('leaves a genuine zero applicable when accounts DO back it', () => {
    // An account classified into the bucket that really holds nothing is an observation.
    const withEmpty = [...accounts, acct({ id: '4', name: 'Old equity', balance: 0 })];
    const r = A.reconcile(A.summarize(withEmpty, { 4: { class: A.CLASS.PRIVATE, stripeKind: 'vested' } }), P);
    const stripe = r.lines.find(l => l.key === 'startingStripeEquity');
    expect(stripe.actual).toBe(0);
    expect(stripe.applicable).toBe(true);              // backed by a real, empty account
  });

  it('does not block a line whose plan value is already zero', () => {
    const r = A.reconcile(A.summarize(accounts, {}), { ...P, startingStripeEquity: 0 });
    expect(r.lines.find(l => l.key === 'startingStripeEquity').applicable).toBe(true);
  });
});

// ── Hiding ───────────────────────────────────────────────────────────────
// The user has a drawer full of accounts closed years ago. Hiding them is a display
// decision, and the one thing it must never do is quietly move net worth.
describe('hiding an account', () => {
  const set = [
    acct({ id: '1', name: 'Chase Checking', category: 'cash', balance: 60000 }),
    acct({ id: '2', name: 'Old Wells Savings', category: 'cash', balance: 0 }),
    acct({ id: '3', name: 'Amex', category: 'liability', balance: -2000 }),
  ];

  it('keeps a hidden account out of every total and every class list', () => {
    const s = A.summarize(set, { 2: { hidden: true } });
    expect(s.byClass[A.CLASS.CASH].accounts.map(a => a.id)).toEqual(['1']);
    expect(s.hidden.map(a => a.id)).toEqual(['2']);
    expect(s.hiddenCount).toBe(1);
  });

  it('is free at a zero balance — and says so', () => {
    const before = A.summarize(set, {});
    const after = A.summarize(set, { 2: { hidden: true } });
    expect(after.netWorth).toBe(before.netWorth);
    expect(after.assets).toBe(before.assets);
    expect(after.hiddenIsCosmetic).toBe(true);
    expect(after.hiddenNote).toMatch(/totals are unchanged/);
  });

  it('is NOT free when the account still holds something, and reports the gap', () => {
    // Net worth genuinely falls here. The alternative — excluding it from the list but
    // keeping it in the total — would be a page that does not add up.
    const s = A.summarize(set, { 1: { hidden: true } });
    expect(s.netWorth).toBe(-2000);
    expect(s.hiddenNet).toBe(60000);
    expect(s.hiddenIsCosmetic).toBe(false);
    expect(s.hiddenNote).toMatch(/NOT in the totals above/);
  });

  it('reports a hidden liability as the debt that left with it', () => {
    const s = A.summarize(set, { 3: { hidden: true } });
    expect(s.debt).toBe(0);
    expect(s.hiddenDebt).toBe(2000);
    expect(s.hiddenNet).toBe(-2000);
    expect(s.hiddenNote).toMatch(/−\$2,000/);
  });

  it('stops calling a hidden account a missing balance, but counts that it did so', () => {
    // Hiding removes it from "resolve these balances" — that is the point. What it must
    // not do is let the plan claim completeness it did not earn without saying why.
    const withGap = [...set, acct({ id: '4', name: 'Dead 2014 broker', balance: undefined })];
    expect(A.summarize(withGap, {}).unknownBalance.map(a => a.id)).toEqual(['4']);
    const s = A.summarize(withGap, { 4: { hidden: true } });
    expect(s.unknownBalance).toEqual([]);
    expect(s.complete).toBe(true);
    expect(s.hiddenUnknown).toBe(1);
    expect(s.hiddenIsCosmetic).toBe(false);          // a decision, not a resolved gap
    expect(s.hiddenNote).toMatch(/no longer counted as missing/);
  });

  it('remembers what the account was, so unhiding restores it unchanged', () => {
    const ov = { 2: { class: A.CLASS.TAXABLE, hidden: true } };
    expect(A.summarize(set, ov).hidden[0].cls).toBe(A.CLASS.TAXABLE);
    const back = A.summarize(set, { 2: { class: A.CLASS.TAXABLE } });
    expect(back.byClass[A.CLASS.TAXABLE].accounts.map(a => a.id)).toEqual(['2']);
  });

  it('says nothing about hiding when nothing is hidden', () => {
    const s = A.summarize(set, { 2: { class: A.CLASS.CASH } });
    expect(s.hiddenCount).toBe(0);
    expect(s.hiddenIsCosmetic).toBe(false);
    expect(s.hiddenNote).toBe(null);
  });

  it('reads the flag off the override by stable id, never the name', () => {
    expect(A.isHidden({ id: '2' }, { 2: { hidden: true } })).toBe(true);
    expect(A.isHidden({ id: '2' }, { 2: { class: A.CLASS.CASH } })).toBe(false);
    expect(A.isHidden({ id: '2' }, {})).toBe(false);
    expect(A.isHidden({}, { 2: { hidden: true } })).toBe(false);
  });
});

// The × is quiet by design — which on a phone is one step from invisible.
describe('the hide control on a phone', () => {
  const css = readFileSync(new URL('../public/ui.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  it('is visible without hover and big enough for a thumb at phone width', () => {
    const m = css.match(/@media\(max-width:640px\)\{\.acct-hide\{([^}]*)\}/);
    expect(m, 'narrow-viewport rule for .acct-hide').toBeTruthy();
    expect(m[1]).toContain('opacity:1');
    expect(Number(m[1].match(/height:(\d+)px/)[1])).toBeGreaterThanOrEqual(40);
  });

  it('is reachable by keyboard and named for a screen reader', () => {
    expect(css).toMatch(/\.acct-hide:focus-visible\{?[^}]*opacity:1|\.acct-hide:focus-visible/);
    expect(html).toContain('aria-label="Hide ');
  });

  it('offers the way back in the same place things went', () => {
    expect(html).toContain('Show again');
    expect(html).toMatch(/setAccountHidden\('\$\{advEscape\(a\.id\)\}',false\)/);
  });
});
