import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const M = require('../public/model.js');
const { migrateObservedOn, rollForwardParams } = require('../public/plan-migrate.js');

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const D = vm.runInNewContext('(' + html.match(/const D=(\{[\s\S]*?\n\});/)[1] + ')');
const OPEN = (D.startingLiquid || 0) + (D.startingStripeEquity || 0) + (D.k401Start || 0);
const on = d => M.run({ ...D, observedOn: d }).R;

// A plan is built from balances observed on a DATE, and that date is rarely 1 January.
// Running a full year of income, spending, saving and return on top of September balances
// counts January–September twice: $1.59M observed became $1.87M by New Year, a $280K gain
// in fifteen weeks that nobody could account for.
describe('the first year models only what is still ahead', () => {
  it('measures the remainder of the year from the observation date', () => {
    expect(M.yearRemaining({ planStartYear: 2026, observedOn: '2026-09-11' })).toBeCloseTo(112 / 365, 4);
    expect(M.yearRemaining({ planStartYear: 2026, observedOn: '2026-01-01' })).toBe(1);
    expect(M.yearRemaining({ planStartYear: 2026, observedOn: '2026-12-31' })).toBeCloseTo(1 / 365, 4);
  });

  it('treats an absent, unparseable or pre-plan date as a whole year ahead', () => {
    // Never guess. Without a date the engine must behave exactly as it always did.
    for (const d of [null, undefined, '', 'not a date', '2025-06-01'])
      expect(M.yearRemaining({ planStartYear: 2026, observedOn: d }), String(d)).toBe(1);
    expect(M.yearRemaining({ planStartYear: 2026, observedOn: '2027-01-01' })).toBe(0);
  });

  it('cuts the first-year gain to something fifteen weeks could produce', () => {
    const full = on(null)[0], stub = on('2026-09-11')[0];
    expect(full.netWorth - OPEN).toBeGreaterThan(300000);   // the complaint
    expect(stub.netWorth - OPEN).toBeLessThan(120000);      // the fix
    expect(stub.stubFrac).toBeCloseTo(112 / 365, 4);
  });

  it('pro-rates income, spending and retirement contributions alike', () => {
    const full = on(null)[0], stub = on('2026-09-11')[0], f = stub.stubFrac;
    // Rounded to whole dollars in the row, so compare to 4 places rather than exactly.
    expect(stub.inc / full.inc).toBeCloseTo(f, 4);
    expect(stub.totE / full.totE).toBeCloseTo(f, 4);
    // …and every reported expense component, so the parts still sum to the total.
    expect(stub.h + stub.liv + stub.cc + stub.tu).toBeCloseTo(stub.totE, 0);
    expect(stub.k401).toBeLessThan(full.k401);
    expect(stub.k401).toBeGreaterThan(D.k401Start);
  });

  it('compounds the return over the remaining months rather than scaling it', () => {
    // A third of a year at 6% is (1.06)^(1/3)−1, not 2%. Scaling understates it.
    const stub = on('2026-09-11')[0], f = stub.stubFrac;
    const grown = D.startingLiquid * Math.pow(1 + D.investReturn, f);
    expect(stub.liq).toBeGreaterThan(grown);                // plus the remaining net flow
    expect(stub.liq).toBeLessThan(D.startingLiquid * (1 + D.investReturn));
  });

  it('still charges the whole year of tax, because that is what is owed', () => {
    // Only the RECEIPT of net pay is pro-rated. The liability for 2026 is a full-year fact
    // and its effective rate reflects income already booked.
    const full = on(null)[0], stub = on('2026-09-11')[0];
    expect(stub.gross).toBe(full.gross);
    expect(stub.tax).toBe(full.tax);
    expect(stub.effRate).toBe(full.effRate);
  });

  it('leaves every later year a full twelve months', () => {
    const R = on('2026-09-11');
    expect(R[0].stubFrac).toBeLessThan(1);
    for (const r of R.slice(1)) expect(r.stubFrac, String(r.yr)).toBe(1);
    // The stub must not compound: 2027 onward should match a plan with no date at all.
    const plain = on(null);
    expect(R.at(-1).netWorth).toBeLessThan(plain.at(-1).netWorth);
    expect(R[1].inc).toBe(plain[1].inc);
    expect(R[2].totE).toBe(plain[2].totE);
  });
});

// Vests land on dates, not on a share of the calendar. Both fractions are right and they
// are deliberately different.
describe('vests are quantised to the tender dates they land on', () => {
  it('counts only the vests still to come, not the fraction of the year left', () => {
    const p = { planStartYear: 2026, observedOn: '2026-09-11' };
    // Vests land 15 Mar / 15 Jun / 15 Sep / 15 Dec. On 11 September the September vest is
    // four days away, so HALF the grant is still ahead — while only 30% of the days are.
    expect(M.stripeVestRemaining(p)).toBe(0.5);
    expect(M.yearRemaining(p)).toBeCloseTo(112 / 365, 4);
    // Four days later the vest has landed and the two fractions cross over.
    expect(M.stripeVestRemaining({ ...p, observedOn: '2026-09-15' })).toBe(0.25);
  });

  it('adds only the remaining vest to the position, and says what was already in it', () => {
    const stub = on('2026-09-11')[0], full = on(null)[0];
    // Exactly half, to the dollar the row is rounded to.
    expect(Math.abs(stub.sAdded - full.sNew * 0.5)).toBeLessThanOrEqual(1);
    expect(Math.abs(stub.sInOpening - full.sNew * 0.5)).toBeLessThanOrEqual(1);
    // The whole year's vest is still INCOME — it was earned and taxed. Only the ASSET is
    // de-duplicated, because three quarters of it is already in the opening balance.
    expect(stub.sNew).toBe(full.sNew);
  });

  it('does not let already-landed vests fund the rest of the year', () => {
    // Offering the whole year's grant to the waterfall would pay for the remaining months
    // with shares that were sold or kept back in February.
    const sell = { ...D, stripePolicy: 'sell', observedOn: '2026-09-11' };
    const r = M.run(sell).R[0];
    expect(r.sSold).toBeLessThanOrEqual(Math.round(r.sNew * 0.5) + 1);
  });

  it('lets an explicit month override the date, for a plan that knows better', () => {
    expect(M.stripeVestRemaining({ planStartYear: 2026, observedOn: '2026-09-11', stripeObservedMonth: 1 })).toBe(1);
  });
});

describe('recording when the balances were true', () => {
  it('stamps today on a plan that has never had a date', () => {
    const p = migrateObservedOn({ planStartYear: 2026 }, '2026-09-11T12:00:00Z');
    expect(p.observedOn).toBe('2026-09-11');
  });

  it('never overwrites a date the plan already recorded, including a deliberate null', () => {
    expect(migrateObservedOn({ planStartYear: 2026, observedOn: '2026-03-04' }, '2026-09-11').observedOn).toBe('2026-03-04');
    expect(migrateObservedOn({ planStartYear: 2026, observedOn: null }, '2026-09-11').observedOn).toBe(null);
  });

  it('does not stamp a date outside the year being stubbed', () => {
    // It would tell the engine nothing usable and would read as a real answer.
    expect(migrateObservedOn({ planStartYear: 2030 }, '2026-09-11').observedOn).toBe(null);
  });

  it('clears the date when the plan rolls into a new year', () => {
    // A date before the new start year reads as "the whole year is ahead", quietly undoing
    // the roll for anyone who then re-observes.
    const rolled = rollForwardParams({ ...D, planStartYear: 2026, observedOn: '2026-09-11' });
    expect(rolled.planStartYear).toBe(2027);
    expect(rolled.observedOn).toBe(null);
    expect(M.yearRemaining(rolled)).toBe(1);
  });
});

describe('the cockpit says the first year is a partial one', () => {
  const cockpit = fs.readFileSync(new URL('../public/cockpit.js', import.meta.url), 'utf8');

  it('shows the share modelled and the date it runs from', () => {
    expect(cockpit).toContain('R[0].stubFrac<1?');
    expect(cockpit).toContain('still ahead of');
    expect(cockpit).toContain('already in your balances');
  });

  it('says nothing at all when the whole year is ahead', () => {
    // The note is a caveat, not decoration: a full first year has nothing to caveat.
    expect(cockpit).toMatch(/stubFrac<1\?`[^`]*`:''/);
  });
});

// The Stripe tab leads with three figures. The third answers "what is this worth at the
// next tender", which is the only one of the three that requires applying a return.
describe('the next-tender figure', () => {
  const sq = html.slice(html.indexOf('At the next tender') - 900,
                        html.indexOf('sq-facts'));

  it('applies the year\'s return, rather than printing the pre-bump number', () => {
    // sEnd is the position at THIS February's mark: vests landed, sales executed, but the
    // year's performance not yet marked. Showing it under "after 30% assumed return" put a
    // pre-bump figure beneath a post-bump caption.
    expect(sq).toContain('const next=Math.round(row.sEnd*(1+row.sRate));');
    expect(sq).toContain('UI.money(next)');
    expect(sq).not.toMatch(/At the next tender<\/span>\s*<strong class="ui-num">\$\{UI\.money\(row\.sEnd\)\}/);
  });

  it('shows both ends of the move, so the bump is legible', () => {
    expect(sq).toContain('UI.money(row.sEnd)');                  // where it stands today
    expect(sq).toContain('UI.money(Math.abs(next-row.sEnd))');   // and what the mark adds
    expect(sq).toMatch(/row\.sRate>=0\?'up':'down'/);            // a negative year reads right
  });

  it('lands exactly where the next row opens, before that year vests', () => {
    // The figure is a claim about the following February. It has to agree with what the
    // engine does at that tender, or the tab and the projection disagree by a year's return.
    const R = M.run({ ...D, observedOn: '2026-09-11', startingStripeEquity: 614000,
      stripePolicy: 'retain', stripeRetY0: 0.30 }).R;
    const shown = Math.round(R[0].sEnd * (1 + R[0].sRate));
    expect(R[1].sBeg).toBe(R[0].sEnd);                  // next year opens at this year's close
    expect(R[1].sMarked).toBe(R[0].sRate);              // …and the re-mark carries this rate
    expect(shown).toBe(Math.round(R[1].sBeg * (1 + R[1].sMarked)));
    // Everything above that at the next year's close is that year's vest, not the re-mark.
    // Within a dollar: sEnd, sBeg and sAdded are each rounded for display independently.
    expect(Math.abs((R[1].sEnd - shown) - R[1].sAdded)).toBeLessThanOrEqual(1);
  });
});

// Every figure in a stub row has to describe the SAME period. Mixing a full year of income
// with a quarter of the spending is not a conservative approximation — it is a number that
// describes no period at all.
describe('net flow describes the same months as the spending', () => {
  const full = on(null)[0], stub = on('2026-09-11')[0];

  it('scales with the stub instead of exceeding a whole year', () => {
    // It previously read $306,243 for fifteen weeks — larger than the $187,714 full year it
    // was supposed to be a fraction of, because only the expense side had been pro-rated.
    expect(stub.flow).toBeLessThan(full.flow);
    expect(stub.flow / full.flow).toBeCloseTo(stub.stubFrac, 3);
  });

  it('is income and spending over the same window, to the dollar', () => {
    expect(stub.flow).toBe(Math.round(stub.netTC * stub.stubFrac - stub.totE));
    expect(full.flow).toBe(Math.round(full.netTC - full.totE));
  });

  it('reports a monthly margin as a RATE, which the stub must not change', () => {
    // flow/12 is wrong in a stub year: there are not twelve months left. The rate itself is
    // unchanged by when you happen to be looking at it.
    expect(stub.flowMonthly).toBe(full.flowMonthly);
    expect(stub.flowMonthly).toBeCloseTo(stub.flow / (12 * stub.stubFrac), 0);
  });

  it('measures the income shortfall over the same window too', () => {
    const tight = { ...D, observedOn: '2026-09-11', baseShopping: 400000 };
    const r = M.run(tight).R[0];
    expect(r.incGap).toBe(Math.round(Math.max(0, r.totE - r.netTC * r.stubFrac)));
  });

  it('has every monthly-margin surface use the rate, not flow/12', () => {
    const cockpit = fs.readFileSync(new URL('../public/cockpit.js', import.meta.url), 'utf8');
    const room = fs.readFileSync(new URL('../public/decision-room.js', import.meta.url), 'utf8');
    for (const [name, src] of [['cockpit', cockpit], ['decision room', room]]) {
      expect(src, name).not.toMatch(/flow\/12/);
      expect(src, name).toContain('flowMonthly');
    }
  });
});
