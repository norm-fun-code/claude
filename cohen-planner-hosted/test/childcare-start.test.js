import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const M = require('../public/model.js');
const T = require('../public/advisor-tools.js');

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const D = vm.runInNewContext('(' + html.match(/const D=(\{[\s\S]*?\n\});/)[1] + ')');
// One child, born 2027, starting school at 3 — so childcare is 2027, 2028, 2029.
const plan = (over) => ({ ...D, planStartYear: 2026, observedOn: null,
  numKids: 1, kid1Birth: 2027, kid1YeshivaStartAge: 3, childcareMonthly: 2800, ...over });
const care = (over) => Object.fromEntries(M.run(plan(over)).R.filter(r => r.yr <= 2031).map(r => [r.yr, r.cc]));

// ── Childcare does not begin at birth ───────────────────────────────────────
// Leave covers the first months, and charging a newborn's whole first year is a bill for
// daycare nobody was using — on the default plan, twelve months of it in the year a child
// arrives.
describe('when childcare starts', () => {
  const mo = 2800;

  it('charges only the months after leave ends, in the birth year', () => {
    expect(care({ childcareStartMonths: 7 })[2027]).toBe(5 * mo);
    expect(care({ childcareStartMonths: 3 })[2027]).toBe(9 * mo);
  });

  it('charges the full year once the child is past that age', () => {
    const c = care({ childcareStartMonths: 7 });
    expect(c[2028]).toBe(12 * mo);
    expect(c[2029]).toBe(12 * mo);
  });

  it('carries a start beyond a year into the NEXT year, rather than clipping at zero', () => {
    // A start of 18 months covers none of the birth year and half of the one after.
    const c = care({ childcareStartMonths: 18 });
    expect(c[2027]).toBe(0);
    expect(c[2028]).toBe(6 * mo);
    expect(c[2029]).toBe(12 * mo);
  });

  it('still ends when school starts, however late it began', () => {
    expect(care({ childcareStartMonths: 7 })[2030]).toBe(0);
    expect(care({ childcareStartMonths: 0 })[2030]).toBe(0);
  });

  it('changes nothing for a plan that never sets it', () => {
    // The default is 0 on purpose: a new input must not silently move a saved projection.
    expect(D.childcareStartMonths).toBe(0);
    expect(care({})).toEqual(care({ childcareStartMonths: 0 }));
    expect(care({})[2027]).toBe(12 * mo);
  });

  it('survives a missing or unusable value as "from birth"', () => {
    for (const v of [undefined, null, '', 'soon', NaN])
      expect(care({ childcareStartMonths: v })[2027]).toBe(12 * mo);
  });

  it('keeps childcare inside the total, so the year still adds up', () => {
    for (const r of M.run(plan({ childcareStartMonths: 7 })).R)
      expect(r.h + r.liv + r.cc + r.tu + r.eAdj).toBe(r.totE);
  });

  it('applies per child, so a second child gets its own leave', () => {
    const two = M.run(plan({ numKids: 2, kid2Birth: 2030, yeshivaStartAge: 3,
      childcareStartMonths: 7 })).R;
    const by = Object.fromEntries(two.map(r => [r.yr, r.cc]));
    expect(by[2030]).toBe(5 * mo);          // kid 2's own first five months of care
    expect(by[2031]).toBe(12 * mo);
  });
});

describe('the input, and who else can see it', () => {
  it('is a control beside the monthly rate, in months', () => {
    expect(html).toContain("s('Starts at age','childcareStartMonths',0,24,1,v=>v?v+' mo old':'birth')");
    expect(html).toContain("childcareStartMonths:v=>v?v+' mo old':'birth'");
  });

  it('says what it does to the birth year, rather than leaving it to be inferred', () => {
    expect(html).toMatch(/Leave covers the first \$\{ccStart\} month/);
    expect(html).toContain("'Charged from birth. Set this if leave covers the first months.'");
  });

  it('is something the advisor can read and set', () => {
    expect(T.validateOverride('childcareStartMonths', 7)).toEqual({ ok: true, value: 7 });
    expect(T.validateOverride('childcareStartMonths', -1).ok).toBe(false);
    expect(html).toMatch(/keys: childcareMonthly, childcareStartMonths/);
    const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    expect(server).toContain('childcareStartMonths (the child\'s age in MONTHS when it begins');
  });
});

describe('it is a lever in the what-if room too', () => {
  const Dec = require('../public/decisions.js');
  const room = fs.readFileSync(new URL('../public/decision-room.js', import.meta.url), 'utf8');

  it('is offered as a slider, in months', () => {
    // Leave is the lever people actually pull here — "back a month earlier" is a real choice,
    // and in the year a child arrives it moves more than the monthly rate does.
    expect(Dec.fields.childcareStartMonths).toMatchObject({ min: 0, max: 24, step: 1, format: 'months' });
    expect(Dec.variant({ childcareStartMonths: 7 }, { childcareStartMonths: 0 }).childcareStartMonths).toBe(0);
  });

  it('reads as an age, not as a bare number or a dollar amount', () => {
    expect(room).toContain("if(f.format==='months')return value?value+' mo old':'birth';");
  });

  it('still refuses a value outside the slider it offered', () => {
    expect(() => Dec.variant({}, { childcareStartMonths: 99 })).toThrow(/out of range/);
  });
});

describe('the caption follows the value it describes', () => {
  it('rebuilds the panel when the months change, like the other structural inputs', () => {
    // It states what the birth year is charged, so a stale one is a wrong statement, not a
    // cosmetic lag.
    expect(html).toContain("key==='planStartYear'||key==='childcareStartMonths')buildControls();");
  });
});
