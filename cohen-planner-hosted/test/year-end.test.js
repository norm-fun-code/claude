import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Y = require('../public/year-end.js');

const row = (over = {}) => ({ yr: 2026, liq: 709539, sEnd: 702557, k401: 320000, eq: 0, ...over });
const observed = (over = {}) => ({ accessible: 700000, stripeVested: 690000,
  byClass: { retirement: { total: 318000 } }, ...over });

describe('noticing the year has turned', () => {
  it('is due once the calendar passes the plan\'s year, not only in January', () => {
    // Someone who skipped the prompt in January is no less stale in March.
    for (const d of ['2027-01-01', '2027-03-14', '2027-12-31']) {
      expect(Y.rollForwardDue({ planStartYear: 2026 }, d)).toMatchObject({ closingYear: 2026, yearsBehind: 1 });
    }
  });

  it('is not due while the plan is describing the year we are in', () => {
    for (const d of ['2026-01-01', '2026-09-16', '2026-12-31']) {
      expect(Y.rollForwardDue({ planStartYear: 2026 }, d)).toBeNull();
    }
  });

  it('counts how far behind, so two skipped years do not read as one', () => {
    expect(Y.rollForwardDue({ planStartYear: 2026 }, '2028-02-01').yearsBehind).toBe(2);
  });

  it('says nothing rather than guessing when the plan or the date is unusable', () => {
    expect(Y.rollForwardDue({}, '2027-01-01')).toBeNull();
    expect(Y.rollForwardDue({ planStartYear: 2026 }, 'not a date')).toBeNull();
  });
});

describe('scoring the closing year', () => {
  it('reports each pool against what the accounts actually hold', () => {
    const c = Y.scorecard({ year: 2026, R: [row()], observed: observed(), accountsAvailable: true });
    expect(c.available).toBe(true);
    const by = Object.fromEntries(c.lines.map(l => [l.key, l]));
    expect(by.liquid).toMatchObject({ planned: 709539, actual: 700000, diff: -9539, kind: 'scored' });
    expect(by.stripe).toMatchObject({ planned: 702557, actual: 690000, diff: -12557 });
    expect(by.retirement).toMatchObject({ planned: 320000, actual: 318000, diff: -2000 });
    expect(c.diff).toBe(-9539 - 12557 - 2000);
    expect(c.verdict).toBe('$24,096 behind plan');
  });

  it('sums the total only from lines it actually scored', () => {
    // Otherwise a total claims to cover something no line measured.
    const c = Y.scorecard({ year: 2026, R: [row({ eq: 400000 })], observed: observed(), accountsAvailable: true });
    expect(c.plannedTotal).toBe(709539 + 702557 + 320000);   // the house is excluded
    expect(c.scored).toBe(3);
  });

  it('marks what the plan carries and the accounts cannot see, rather than scoring it as a miss', () => {
    const c = Y.scorecard({ year: 2026, R: [row({ eq: 400000 })], observed: observed(), accountsAvailable: true });
    const home = c.lines.find(l => l.key === 'home');
    expect(home).toMatchObject({ kind: 'unobservable', planned: 400000, actual: null, diff: null });
    expect(home.note).toMatch(/not visible to your accounts/i);
  });

  it('marks a pool the accounts should report but did not as unknown, never as zero', () => {
    const c = Y.scorecard({ year: 2026, R: [row()],
      observed: observed({ byClass: {} }), accountsAvailable: true });
    const ret = c.lines.find(l => l.key === 'retirement');
    expect(ret.kind).toBe('unknown');
    expect(ret.actual).toBeNull();
    expect(ret.diff).toBeNull();
    expect(c.complete).toBe(false);
    expect(c.diff).toBe(-9539 - 12557);   // and it is not counted in the total either
  });

  it('says how far after the year the balances were read', () => {
    expect(Y.scorecard({ year: 2026, R: [row()], observed: observed(), accountsAvailable: true,
      observedOn: '2027-01-09' }).driftDays).toBe(8);
    expect(Y.scorecard({ year: 2026, R: [row()], observed: observed(), accountsAvailable: true,
      observedOn: '2026-12-28' }).driftDays).toBe(-4);
  });

  it('calls a year that landed on the number exactly that', () => {
    const c = Y.scorecard({ year: 2026, R: [row()],
      observed: observed({ accessible: 709539, stripeVested: 702557, byClass: { retirement: { total: 320000 } } }),
      accountsAvailable: true });
    expect(c.diff).toBe(0);
    expect(c.verdict).toBe('exactly as planned');
  });

  it('returns nothing rather than a hollow card when there is nothing to score', () => {
    expect(Y.scorecard({ year: 2026, R: [], observed: observed(), accountsAvailable: true })).toBeNull();
    expect(Y.scorecard({ year: 2026, R: [row()], observed: null, accountsAvailable: false }))
      .toMatchObject({ available: false });
    expect(Y.scorecard({ year: 2026, R: [row()], observed: observed(), accountsAvailable: false }).reason)
      .toMatch(/no account balances/i);
  });
});

// The two sides of a scorecard are a projection for a year that closed and the balances
// standing now. How far apart those are is a property of the BALANCES — measuring it from
// the plan's own opening observation would report the age of the wrong thing entirely.
describe('the drift the card reports', () => {
  it('is measured from when the actuals were read', () => {
    const src = require('fs').readFileSync(new URL('../public/cockpit.js', import.meta.url), 'utf8');
    expect(src).toContain("observedOn:d&&d.asOf?String(d.asOf).slice(0,10):null");
    expect(src).not.toContain('accountsAvailable:available,observedOn:P.observedOn');
  });
});
