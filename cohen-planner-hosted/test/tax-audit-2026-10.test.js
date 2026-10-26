import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const M = require('../public/model.js');

// A W-2 household with nothing unusual: the two corrections from the October audit.
const base = { planStartYear: 2026, taxInflation: .025, pretax401k: 23500, pretaxBenefits: 11700, housingMode: 'rent',
  baseCharity: 0, expenseInflation: 0, nancyQBIRate: .2, homePurchaseYear: 2100, _normW2: 150000, _nancyW2: 0, _nancySE: 0 };

describe('tax audit, October 2026', () => {
  it('does not charge Social Security or Medicare on §125 benefits (but does on 401(k) deferrals)', () => {
    const t = M.calcTax(150000, base, 2026, 0);
    // FICA on $150,000 − $11,700 of benefits; the $23,500 401(k) deferral stays in FICA wages.
    expect(t.fica).toBe(Math.round((150000 - 11700) * .0765));
  });
  it('takes $1,000 per dependent off New York State and City taxable income', () => {
    const none = M.calcTax(150000, base, 2026, 0), two = M.calcTax(150000, { ...base, _taxDependents: 2 }, 2026, 0);
    // $2,000 of taxable income at this household's top NYS (5.4%) and NYC (3.876%) rates.
    expect(none.state - two.state).toBeCloseTo(2000 * .054, 0);
    expect(none.city - two.city).toBeCloseTo(2000 * .03876, 0);
  });
});
