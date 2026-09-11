import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const M=require('../public/model.js');
const Sp=require('../public/spending.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');

// F4 — the SALT deduction is for taxes PAID, limited by the cap.
describe('SALT deducts what was actually paid, up to the cap',()=>{
  it('a modest household deducts its real state and city tax, not the cap',()=>{
    const t=M.calcTax(80000,{...D,_normW2:80000,_nancyW2:0,_nancySE:0,
      homePurchaseYear:9999,baseCharity:0,pretax401k:0,pretaxBenefits:0},2026,0);
    expect(t.saltPaid).toBe(t.state+t.city);
    expect(t.saltDeduction).toBe(t.saltPaid);
    expect(t.saltDeduction).toBeLessThan(6000);
    // Which means the standard deduction wins, as it should at this income.
    expect(t.deduction).toBe(32200);
  });

  it('a high earner is limited by the cap rather than by what they paid',()=>{
    const t=M.calcTax(900000,{...D,_normW2:900000,_nancyW2:0,_nancySE:0,
      homePurchaseYear:9999,baseCharity:0},2026,0);
    expect(t.saltPaid).toBeGreaterThan(t.saltCap);
    expect(t.saltDeduction).toBe(t.saltCap);
  });

  it('counts property tax as an eligible tax once the house exists',()=>{
    const base={...D,_normW2:400000,_nancyW2:0,_nancySE:0,baseCharity:0,
      homePrice:2000000,downPctg:20,mortgageRate:6,homeAppreciation:0.03};
    const renting=M.calcTax(400000,{...base,homePurchaseYear:9999},2026,0);
    const owning=M.calcTax(400000,{...base,homePurchaseYear:2026},2026,0);
    expect(owning.propertyTax).toBeGreaterThan(0);
    expect(renting.propertyTax).toBe(0);
    expect(owning.saltPaid-renting.saltPaid).toBeCloseTo(owning.propertyTax,0);
  });

  it('grows the cap 1%/yr and drops it to $10,000 in 2030',()=>{
    const p={...D,_normW2:300000,_nancyW2:0,_nancySE:0,homePurchaseYear:9999,baseCharity:0};
    expect(M.calcTax(300000,p,2026,0).saltCap).toBe(40400);
    expect(M.calcTax(300000,p,2027,0).saltCap).toBe(40804);
    expect(M.calcTax(300000,p,2029,0).saltCap).toBe(41624);
    expect(M.calcTax(300000,p,2030,0).saltCap).toBe(10000);
    expect(M.calcTax(300000,p,2040,0).saltCap).toBe(10000);
  });
});

// F3 — zero is a value, not an absence.
describe('Valid zeros are honoured',()=>{
  it('a 0% mortgage amortises straight-line instead of producing NaN',()=>{
    const t=M.calcTax(500000,{...D,_normW2:500000,_nancyW2:0,_nancySE:0,
      mortgageRate:0,homePurchaseYear:2026,homePrice:1000000,downPctg:20},2026,0);
    expect(Number.isFinite(t.allInTax)).toBe(true);
    expect(t.mortInt).toBe(0);          // no interest on a 0% loan
    expect(M.mPmt(1000000,0)).toBe(1000000/30);
    expect(M.mBal(1000000,0,15)).toBe(500000);
    expect(M.mBal(1000000,0,30)).toBe(0);
    // And the whole projection stays finite.
    const R=M.run({...D,mortgageRate:0,homePurchaseYear:2027}).R;
    for(const r of R)expect(Number.isFinite(r.nw),String(r.yr)).toBe(true);
  });

  it('an explicitly zero retirement balance stays zero',()=>{
    const r=M.run({...D,k401Start:0,pretax401k:0,company401kMatch:0,investReturn:0}).R[0];
    expect(r.k401).toBe(0);
    // And an omitted one still gets the documented default.
    const p={...D};delete p.k401Start;
    expect(M.run({...p,pretax401k:0,company401kMatch:0,investReturn:0}).R[0].k401).toBe(210000);
  });
});

// F3 — one calendar, everywhere.
describe('Month progress uses one calendar',()=>{
  it('reports the same progress regardless of the host timezone',()=>{
    const months=[{month:'2026-03',expense:1000}];
    const c=Sp.coverage(months,'2026-03-10');
    expect(c.partial).toBe('2026-03');
    // 10 of 31 days, whatever the machine's offset.
    expect(c.fractionElapsed).toBeCloseTo(10/31,4);
  });

  it('does not slip a month at the boundary',()=>{
    expect(Sp.coverage([{month:'2026-03',expense:1}],'2026-03-01').partial).toBe('2026-03');
    expect(Sp.coverage([{month:'2026-02',expense:1}],'2026-02-28').fractionElapsed).toBeCloseTo(1,4);
  });
});
