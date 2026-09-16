import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const M = require('../public/model.js');
const T = require('../public/advisor-tools.js');

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const D = vm.runInNewContext('(' + html.match(/const D=(\{[\s\S]*?\n\});/)[1] + ')');
const plan = (over) => ({ ...D, planStartYear: 2026, observedOn: null, ...over });
const yr = (P, y) => M.run(P).R.find(r => r.yr === y);

// ── A cost that happens once ────────────────────────────────────────────────
// Every other expense input is a LEVEL or a RATE — a monthly rent, a grocery baseline, an
// inflation assumption — and all of them apply to every year. "Add $20K to 2027 for the baby"
// had no key at all, so the advisor's only honest answer was that it could not do it, and its
// only dishonest one was to raise a base category and change every later year too.
describe('a one-off expense lands in the year it is named for', () => {
  it('moves that year and no other', () => {
    const base = M.run(plan()).R, after = M.run(plan({ expenseAdjY1: 20000 })).R;
    expect(after[1].totE - base[1].totE).toBe(20000);
    expect(after[1].eAdj).toBe(20000);
    for (const i of [0, 2, 3, 10]) expect(after[i].totE).toBe(base[i].totE);
  });

  it('is spending, so it moves net flow and the cash the waterfall must find', () => {
    // Parked in a note beside the total it would be decoration. It has to reach the figures
    // that answer "can I afford this year".
    const base = yr(plan(), 2027), after = yr(plan({ expenseAdjY1: 20000 }), 2027);
    expect(base.flow - after.flow).toBe(20000);
    expect(after.incGap - base.incGap).toBeGreaterThanOrEqual(0);
  });

  it('keeps the components summing to the total exactly', () => {
    const r = yr(plan({ expenseAdjY1: 20000 }), 2027);
    expect(r.h + r.liv + r.cc + r.tu + r.eAdj).toBe(r.totE);
  });

  it('is not inflated — a figure typed against a year is in that year\'s dollars', () => {
    // Compounding it would quietly turn $20,000 in 2036 into something nobody said.
    const r = yr(plan({ expenseAdjY10: 20000, expenseInflation: 0.03 }), 2036);
    expect(r.eAdj).toBe(20000);
  });

  it('takes a negative for a year that costs less', () => {
    const base = yr(plan(), 2028), after = yr(plan({ expenseAdjY2: -5000 }), 2028);
    expect(base.totE - after.totE).toBe(5000);
  });

  it('ignores an index outside the range it covers, rather than silently applying it elsewhere', () => {
    expect(M.expenseAdjFor({ expenseAdjY11: 5000 }, 2037, 2026)).toBe(0);
    expect(M.expenseAdjFor({ expenseAdjY1: 5000 }, 2025, 2026)).toBe(0);   // before the plan
    expect(M.expenseAdjFor({ expenseAdjY1: 'lots' }, 2027, 2026)).toBe(0); // unusable
  });

  it('changes nothing at all when no adjustment is set', () => {
    const r = yr(plan(), 2027);
    expect(r.eAdj).toBe(0);
    expect(r.h + r.liv + r.cc + r.tu).toBe(r.totE);
  });
});

describe('the advisor can set one, and cannot set nonsense', () => {
  it('accepts a signed adjustment for any year the series covers', () => {
    expect(T.validateOverride('expenseAdjY1', 20000)).toEqual({ ok: true, value: 20000 });
    expect(T.validateOverride('expenseAdjY0', -5000).ok).toBe(true);
    expect(T.validateOverride('expenseAdjY10', 1000).ok).toBe(true);
  });

  it('refuses a year beyond the series and says how far it goes', () => {
    const v = T.validateOverride('expenseAdjY11', 1000);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/goes up to expenseAdjY10/);
  });

  it('can say WHEN a child arrives, not only how many', () => {
    // numKids alone could add a child with no way to state the year — and the year is what
    // drives childcare and tuition.
    expect(T.validateOverride('kid2Birth', 2031).ok).toBe(true);
    expect(T.validateOverride('kid1Birth', 2027).ok).toBe(true);
  });

  it('runs the real engine when it proposes one, rather than describing it', () => {
    const P = plan();
    const before = T.getProjection({ P, from: 2027, to: 2027 }).years[0].expenses.total;
    const after = T.getProjection({ P, overrides: { expenseAdjY1: 20000 }, from: 2027, to: 2027 });
    expect(after.years[0].expenses.total).toBe(before + 20000);
    expect(after.applied.expenseAdjY1.to).toBe(20000);
  });
});

// ── "I can see the total but not the categories" ────────────────────────────
// METRICS is a fixed vocabulary of headline figures — right for "what happens if", useless
// for "how does 2027 reach $220K". The advisor could quote the total and not one thing inside
// it, and said so.
describe('get_projection breaks a year down', () => {
  const P = plan();

  it('returns the four components, and they sum to the total exactly', () => {
    const e = T.getProjection({ P, from: 2027, to: 2027 }).years[0].expenses;
    expect(e.housing + e.living + e.childcare + e.tuition + e.oneOffAdjustment).toBe(e.total);
    expect(e.total).toBeGreaterThan(0);
  });

  it('says what housing and living actually contain, so the labels are not guesses', () => {
    const n = T.getProjection({ P, from: 2027, to: 2027 }).notes;
    expect(n.expenses).toMatch(/mortgage \+ property tax \+ insurance \+ maintenance/);
    expect(n.expenses).toMatch(/groceries, dining, shopping/);
  });

  it('carries income, flow and balances for the same year, so one call answers the question', () => {
    const y = T.getProjection({ P, from: 2027, to: 2027 }).years[0];
    expect(y.income.gross).toBeGreaterThan(0);
    expect(y.balances.netWorth).toBeGreaterThan(0);
    expect(y.netFlow).toBe(yr(P, 2027).flow);
  });

  it('marks a stub year rather than letting a part year read as a whole one', () => {
    const y = T.getProjection({ P: plan({ observedOn: '2026-09-16' }), from: 2026, to: 2026 }).years[0];
    expect(y.fractionOfYearModelled).toBeLessThan(1);
    expect(y.expenses.fullYearTotal).toBeGreaterThan(y.expenses.total);
  });

  it('keeps the two gap measures apart, with the warning attached', () => {
    const n = T.getProjection({ P, from: 2027, to: 2027 }).notes;
    expect(n.cashGap).toMatch(/Never call it a deficit/);
    expect(n.incomeGap).toMatch(/draws on savings/);
  });

  it('narrows to the years asked for, and says so when the range holds none', () => {
    expect(T.getProjection({ P, from: 2030, to: 2032 }).years.map(y => y.year)).toEqual([2030, 2031, 2032]);
    expect(T.getProjection({ P, from: 2100, to: 2101 }).error).toMatch(/holds no years/);
  });

  it('refuses the whole call rather than running a scenario missing one of its changes', () => {
    const r = T.getProjection({ P, overrides: { notAKey: 1 } });
    expect(r.error).toMatch(/not a parameter this plan has/);
    expect(r.years).toBeUndefined();
  });
});

describe('what the advisor is told, and what the table shows', () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

  it('is told to break a total down instead of saying it cannot', () => {
    expect(server).toMatch(/never tell the user you can see the total but\s*\n?not the categories/i);
    expect(server).toContain('get_projection returns each year with its expense composition');
  });

  it('is told a one-off belongs in expenseAdjY, not in a base category', () => {
    // Raising nycRent or baseGroceries to model one year silently changes every year after.
    expect(server).toMatch(/expenseAdjY0…Y10, indexed from the plan's\s*\n?start year/);
    expect(server).toMatch(/silently changes every year after it. Never do that/);
    expect(server).toContain('expenseAdjY0 … expenseAdjY10');   // the agentic prompt too
  });

  it('is dispatched to the real executor', () => {
    expect(server).toContain("case 'get_projection':");
    expect(server).toContain('AdvisorTools.getProjection({ P, overrides: input.overrides, from: input.from, to: input.to })');
  });

  it('carries the current year\'s composition in the live context as well', () => {
    expect(html).toContain('• Housing ${fmt(y26.h)} · Living ${fmt(y26.liv)} · Childcare ${fmt(y26.cc)} · Tuition ${fmt(y26.tu)}');
    expect(html).toMatch(/For ANY other year's breakdown call get_projection/);
  });

  it('shows the components as columns beside the total they make', () => {
    expect(html).toContain("'Housing','Living','Childcare','Tuition',...(anyAdj?['One-off']:[]),'Expenses',");
    // The one-off column only exists when some year carries one.
    expect(html).toContain('const anyAdj=R.some(r=>r.eAdj);');
  });
});

// ── Editable by hand, not only through the advisor ──────────────────────────
describe('the one-off control in the Expenses panel', () => {
  it('stores nothing at all for a zero, so an emptied row leaves no trace in the plan', () => {
    // A key set to 0 would persist, serialise and read back as a deliberate "this year costs
    // nothing extra" — indistinguishable from a row someone deleted.
    expect(html).toContain("if(n)P['expenseAdjY'+i]=n;else delete P['expenseAdjY'+i];");
  });

  it('refuses to add an empty amount rather than creating a row that does nothing', () => {
    expect(html).toContain("if(!n){a.focus();showToast('Enter an amount for the one-off cost.','red');return}");
  });

  it('offers only years that do not already have one', () => {
    expect(html).toContain("const free=Array.from({length:11},(_,i)=>sy0+i).filter(y=>!set.some(([sy])=>sy===y));");
  });

  it('indexes from the plan start year, the same way the engine does', () => {
    expect(html).toContain('const sy=P.planStartYear||2026,i=year-sy;');
    expect(html).toContain('if(i<0||i>10)return;');
  });

  it('rebuilds the controls after a change, so the list and the free years follow it', () => {
    expect(html).toContain('markDirty();buildControls();render();savePlannerState();');
  });
});

// A field that displays a typographic minus and parses only an ASCII one flips a negative
// row positive the moment someone edits it and presses enter. Caught in the browser.
describe('the sign survives a round trip through the field', () => {
  it('reads back the minus sign it writes', () => {
    expect(html).toContain("value=\"${(v<0?'−':'')+fmtF(Math.abs(v))}\"");
    expect(html).toContain("String(val).replace(/−/g,'-').replace(/[^0-9.-]/g,'')");
    expect(html).toContain("String(a.value).replace(/−/g,'-').replace(/[^0-9.-]/g,'')");
  });
});
