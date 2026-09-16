import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const M = require('../public/model.js');
const D = require('../public/decisions.js');

const room = fs.readFileSync(new URL('../public/decision-room.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/decision-room.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const DEF = vm.runInNewContext('(' + html.match(/const D=(\{[\s\S]*?\n\});/)[1] + ')');
const plan = (over) => ({ ...DEF, planStartYear: 2026, observedOn: null, ...over });

// ── A what-if is asked about a year ─────────────────────────────────────────
// The comparison reported two rows for the chosen year and the rest at plan end, and the
// only control that chose that year sat inside a collapsed fold below it. So "how does this
// change 2027" could not be asked where the answer was.
describe('choosing the year the comparison is about', () => {
  it('puts the picker with the comparison, not in the timeline fold', () => {
    expect(room).toContain('<label for="decisionYearPick">Compare year</label>');
    expect(room).toContain('onchange="decisionSelectYear(Number(this.value),false)"');
    expect(room).toContain('onclick="decisionStepYear(-1)"');
  });

  it('does not throw the fold open when the year came from the picker', () => {
    // Opening a fold underneath the thing being read is right for a milestone button down
    // there and wrong for a control up here.
    expect(room).toContain('function decisionSelectYear(year,reveal){');
    expect(room).toContain("if(reveal!==false){const fold=document.getElementById('decisionContextFold');if(fold)fold.open=true;}");
  });

  it('keeps the picker, the scrubber and its label on the same year', () => {
    for (const id of ['decisionYear', 'decisionYearLabel', 'decisionYearPick'])
      expect(room).toContain(`document.getElementById('${id}')`);
  });

  it('cannot step outside the plan, and says so by disabling the arrow', () => {
    expect(room).toContain('Math.max(R[0].yr,Math.min(R[R.length-1].yr,decisionYear+by))');
    expect(room).toMatch(/aria-label="Previous year"\$\{yr<=years\[0\]\?' disabled':''\}/);
    expect(room).toMatch(/aria-label="Next year"\$\{yr>=years\[years\.length-1\]\?' disabled':''\}/);
  });

  it('groups the year rows apart from the plan-wide ones', () => {
    // Read as one list, only the plan-end rows felt like the answer.
    expect(room).toContain("['head',`In ${yr}`]");
    expect(room).toContain("['head','Across the whole plan']");
    expect(css).toContain('.dr-comparison .dr-group th{text-align:left');
  });

  it('answers five things about that year, not two', () => {
    for (const label of ['Net flow / mo', 'Total spending', 'Vest sold to cover', 'Liquid assets'])
      expect(room).toContain(`['${label}'`);
    expect(room).toContain("['Net worth',fmt(at(a.current.netWorth))");
  });
});

// ── The change column has to mean what it looks like ────────────────────────
describe('the change column colours what is GOOD, not what went up', () => {
  it('marks the three rows where a rise is worse', () => {
    // Spending, vest sold to cover it and years drawing on savings all rise when a plan gets
    // harder. Painting them green would have the panel saying the opposite of what it means.
    expect(room).toContain('const chg=(x,z,f,worseUp)=>{');
    expect(room).toContain('const good=worseUp?d<0:d>0;');
    expect(room).toContain('chg(at(a.current.totE),at(b.current.totE),null,true)');
    expect(room).toContain('chg(at(a.current.gap),at(b.current.gap),null,true)');
    expect(room).toContain("chg(a.deficitYears,b.deficitYears,n=>n+(n===1?' yr':' yrs'),true)");
  });

  it('prints no delta where one side is not a number', () => {
    // "Outside horizon" minus "None" is not a figure, and inventing one would be worse than
    // the dash.
    expect(room).toContain("if(!Number.isFinite(x)||!Number.isFinite(z))return '<td class=\"dr-chg\">—</td>';");
    expect(room).toContain("if(Math.round(d)===0)return '<td class=\"dr-chg\">no change</td>';");
  });
});

// ── The figures behind it ───────────────────────────────────────────────────
describe('what the year rows actually compare', () => {
  const R = M.run(plan()).R;

  it('reads the chosen year from the projection, not the nearest one', () => {
    for (const y of [2026, 2030, 2040, 2058])
      expect(D.summarize(plan(), R, y).current.yr).toBe(y);
  });

  it('shows a change in the year an assumption bites, and none in a year it does not', () => {
    // Higher childcare costs real money while a child is in it and nothing once they are in
    // school — which is the whole reason a single plan-end figure cannot answer the question.
    const base = D.summarize(plan(), R, 2027);
    const hiR = M.run(plan({ childcareMonthly: 3800 })).R;
    const hi = D.summarize(plan({ childcareMonthly: 3800 }), hiR, 2027);
    expect(hi.current.totE).toBeGreaterThan(base.current.totE);

    const late = 2040;
    expect(D.summarize(plan({ childcareMonthly: 3800 }), hiR, late).current.totE)
      .toBe(D.summarize(plan(), R, late).current.totE);
  });
});
