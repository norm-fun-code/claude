import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const M=require('../public/model.js');
const T=require('../public/tax-rules.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');

// The engine's own opinion of itself, as the app supplies it.
const engineOpts={
  taxInflation:D.taxInflation,
  indexStateBrackets:D.indexStateBrackets??false,
  qbiPhaseBase:403500,qbiBandWidth:150000,
  modelsNIIT:false,modelsAMT:false,capGainsTaxRate:D.capGainsTaxRate,
};

describe('The tax rule table is a citation, not a memory',()=>{
  it('gives every rule a year, a jurisdiction and a primary source',()=>{
    for(const [id,r] of Object.entries(T.RULES)){
      expect(r.year,id).toBe(2026);
      expect(r.jurisdiction,id).toMatch(/^US-(Federal|NY|NYC)$/);
      const src=T.SOURCES[r.source];
      expect(src,`${id} cites an unknown source`).toBeTruthy();
      expect(src.primary,`${id} cites a non-primary source`).toBe(true);
      expect(src.url,id).toMatch(/^https:\/\//);
      expect(r.citation,`${id} has no pinpoint citation`).toBeTruthy();
    }
  });

  it('records whether each figure is indexed, because that drives every future year',()=>{
    // The four that matter most for a 33-year projection, and the ones the engine got wrong.
    expect(T.RULES.fedBracketsMFJ.indexed).toBe(true);
    expect(T.RULES.nysBracketsMFJ.indexed).toBe(false);
    expect(T.RULES.nycBracketsMFJ.indexed).toBe(false);
    expect(T.RULES.niitMFJ.indexed).toBe(false);
  });

  it('renders a citation a person can actually go and check',()=>{
    const c=T.cite('fedBracketsMFJ');
    expect(c).toContain('2026');
    expect(c).toContain('Internal Revenue Service');
    expect(c).toContain('Rev. Proc. 2025-32');
    expect(c).toContain('https://');
    expect(c).toContain('retrieved');
  });

  it('says how old it is instead of implying the figures are live',()=>{
    const fresh=T.staleness('2026-09-10');
    expect(fresh.ageDays).toBe(0);
    expect(fresh.coversCurrentYear).toBe(true);
    // Once planning has moved to the next tax year, the table must say so rather than
    // presenting last year's thresholds as current law.
    const stale=T.staleness('2027-06-01');
    expect(stale.coversCurrentYear).toBe(false);
    expect(stale.note).toMatch(/Re-read the sources/);
  });
});

describe('The engine validates against the table',()=>{
  const result=T.validate(M,engineOpts);

  it('has no outstanding errors',()=>{
    const errs=result.findings.filter(f=>f.severity===T.SEV.ERROR);
    expect(errs.map(e=>e.label)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('still declares what it does NOT model, rather than staying silent',()=>{
    // Silence about a tax is a claim that the tax is zero. These must remain visible.
    const labels=result.findings.map(f=>f.label).join(' | ');
    expect(labels).toMatch(/Net Investment Income Tax/);
    expect(labels).toMatch(/Alternative Minimum Tax/);
    expect(labels).toMatch(/SALT cap/);
  });

  it('attaches a citation and a concrete fix to every finding',()=>{
    for(const f of result.findings){
      expect(f.rule,f.label).toBeTruthy();
      expect(f.fix,f.label).toBeTruthy();
      expect(f.impact,f.label).toBeTruthy();
    }
  });

  it('catches a regression in any constant it covers',()=>{
    const broken={...M,STD_DEDUCT_2026:29200,SS_CAP_2026:176100};
    const r=T.validate(broken,engineOpts);
    expect(r.passed).toBe(false);
    const ids=r.findings.filter(f=>f.severity===T.SEV.ERROR).map(f=>f.id);
    expect(ids).toContain('fedStandardDeductionMFJ');
    expect(ids).toContain('socialSecurityWageBase');
  });

  it('catches a wrong bracket walk, not just a wrong constant',()=>{
    // Same constants, broken arithmetic: tax the whole income at the top marginal rate.
    const broken={...M,bracketTax:(income,br)=>income*br[br.length-1][1]};
    const r=T.validate(broken,engineOpts);
    expect(r.passed).toBe(false);
    expect(r.findings.some(f=>/bracketTax/.test(f.label))).toBe(true);
  });
});

describe('The four discrepancies this validation actually found',()=>{
  // Regression locks. Each of these was wrong in the shipped engine.
  it('federal 35% band ends at $768,700 (Rev. Proc. 2025-32 Table 1)',()=>{
    expect(M.FED_BR_2026[5]).toEqual([768700,.35]);
    // Cumulative tax at the top of each band, straight from the printed table.
    expect(Math.round(M.bracketTax(768700,M.FED_BR_2026))).toBe(206584);
    expect(Math.round(M.bracketTax(211400,M.FED_BR_2026))).toBe(35932);
  });

  it('New York cut each of its five lowest rates by 0.1 point for 2026',()=>{
    expect(M.NYS_BR_2026.slice(0,5).map(b=>b[1])).toEqual([.0390,.0440,.0515,.0540,.0590]);
    // Thresholds did not move.
    expect(M.NYS_BR_2026.slice(0,5).map(b=>b[0])).toEqual([17150,23600,27900,161550,323200]);
  });

  it('§ 199A phases in over $403,500 → $553,500, a $150K band',()=>{
    const base={...D,nancySoloPractice:1,_nancySE:200000,_normW2:0,_nancyW2:0};
    // Just below the threshold the deduction is whole; just above the top it is gone.
    const below=M.calcTax(430000,{...base,_normW2:230000},2026,0);
    const above=M.calcTax(800000,{...base,_normW2:600000},2026,0);
    expect(below.qbi).toBeGreaterThan(0);
    expect(above.qbi).toBe(0);
    // And it never goes negative, which would perversely raise taxable income.
    for(const w of [200000,300000,400000,450000,500000,550000,600000])
      expect(M.calcTax(w+200000,{...base,_normW2:w},2026,0).qbi).toBeGreaterThanOrEqual(0);
  });

  it('New York brackets stay frozen across the projection, because the statute freezes them',()=>{
    const p={...D,_normW2:500000,_nancyW2:0,_nancySE:0};
    const y0=M.calcTax(500000,p,2026,0);
    const y20=M.calcTax(500000,p,2046,0);
    // Same nominal income 20 years later: federal falls (indexed brackets), New York does not.
    expect(y20.state).toBe(y0.state);
    expect(y20.city).toBe(y0.city);
    expect(y20.federal).toBeLessThan(y0.federal);
  });

  it('can still reproduce the old escalating-New-York behaviour on request',()=>{
    const p={...D,_normW2:500000,_nancyW2:0,_nancySE:0,indexStateBrackets:true};
    expect(M.calcTax(500000,p,2046,0).state).toBeLessThan(M.calcTax(500000,p,2026,0).state);
  });
});

describe('Sanity of the corrected engine against hand-computed figures',()=>{
  // A single-earner MFJ household, no kids, no house, no practice: everything below is
  // computable by hand from the cited tables, so a silent change in the engine breaks it.
  const p={...D,planStartYear:2026,homePurchaseYear:9999,pretax401k:0,pretaxBenefits:0,
    baseCharity:0,nancySoloPractice:0,_normW2:400000,_nancyW2:0,_nancySE:0,_nancyOverhead:0};
  const t=M.calcTax(400000,p,2026,0);

  it('deducts the taxes paid, limited by the cap, against the standard deduction',()=>{
    // AGI $400K is below the $505K phase-down, so the cap is the full $40,400 — and New
    // York tax at this income is under it, so what is deducted is what was PAID.
    expect(t.saltCap).toBe(40400);
    expect(t.saltPaid).toBe(t.state+t.city);
    expect(t.saltDeduction).toBe(Math.min(t.saltPaid,t.saltCap));
    expect(t.deduction).toBe(Math.max(32200,t.saltDeduction));
    expect(t.itemizing).toBe(t.saltDeduction>32200);
  });

  it('computes federal tax straight off the bracket table',()=>{
    expect(t.agi).toBe(400000);
    expect(Math.round(t.federal)).toBe(Math.round(M.bracketTax(400000-t.deduction,M.FED_BR_2026)));
  });

  it('caps Social Security at the wage base and never caps Medicare',()=>{
    const expected=Math.round(184500*.062+400000*.0145+Math.max(0,400000-250000)*.009);
    expect(t.fica).toBe(expected);
  });

  it('drives the SALT deduction to its $10,000 floor at high income',()=>{
    // 40,400 − 0.30 × (606,333 − 505,000) ≈ 10,000.
    const hi=M.calcTax(900000,{...p,_normW2:900000},2026,0);
    expect(hi.saltCap).toBe(10000);
    // And at that point the standard deduction wins instead.
    expect(hi.deduction).toBe(32200);
  });
});
