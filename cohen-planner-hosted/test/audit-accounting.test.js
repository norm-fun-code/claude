import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const M=require('../public/model.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');

describe('independent accounting audit',()=>{
  it('credits the principal paid in the purchase year to home equity',()=>{
    const p={...D,observedOn:null,homePurchaseYear:2027,homeAppreciation:0};
    const r=M.run(p).R.find(r=>r.yr===2027);
    const loan=p.homePrice*(1-p.downPctg/100);
    expect(r.eq).toBe(Math.round(p.homePrice-M.mBal(loan,p.mortgageRate/100,1)));
  });
  it('ends payments and interest after the thirtieth year',()=>{
    const p={...D,observedOn:null,homePurchaseYear:2026,homeAppreciation:0,maintBase:0,homeInsuranceAnnual:0,homeInsuranceRate:0,propTaxRate:0};
    const rows=M.run(p).R;
    expect(rows.find(r=>r.yr===2055).hFull).toBeGreaterThan(0);
    expect(rows.find(r=>r.yr===2056).hFull).toBe(0);
    expect(rows.find(r=>r.yr===2056).eq).toBe(p.homePrice);
    const tax=M.calcTax(500000,{...p,_normW2:500000,_nancyW2:0,_nancySE:0},2056,0);
    expect(tax.mortInt).toBe(0);
  });
  it('preserves wealth while repaying a zero-interest mortgage',()=>{
    const p={...D,observedOn:null,homePurchaseYear:2027,homeAppreciation:0,mortgageRate:0};
    const r=M.run(p).R.find(r=>r.yr===2027);
    const loan=p.homePrice*(1-p.downPctg/100);
    expect(r.eq).toBe(Math.round(p.homePrice-loan+loan/30));
  });
  it('does not charge the home-office deduction again as cash overhead',()=>{
    const p={...D,observedOn:null,homePurchaseYear:2026,nancyRampYear:2026,nancySoloPractice:1};
    const r=M.run(p).R[0];
    expect(r.netTC).toBeCloseTo(r.gross-r.tax-p.pretax401k-p.pretaxBenefits-p.nancyPracticeOverhead,0);
  });
  it('uses calendar-year tax indexing independently of the projection start',()=>{
    const p={...D,housingMode:'rent',_normW2:400000,_nancyW2:0,_nancySE:0};
    expect(M.calcTax(400000,{...p,planStartYear:2030},2030,0)).toEqual(M.calcTax(400000,{...p,planStartYear:2026},2030,0));
  });
  it('does not inflate the $400k child-credit phaseout threshold',()=>{
    const p={...D,housingMode:'rent',pretax401k:0,pretaxBenefits:0,_normW2:600000,_nancyW2:0,_nancySE:0};
    expect(M.calcTax(600000,p,2040,3).federal).toBe(M.calcTax(600000,p,2040,0).federal);
  });
  it('reconciles remaining cash and discrete stock vests to reported flow',()=>{
    for(const date of ['2026-09-11','2026-10-08','2026-12-16']){
      const r=M.run({...D,observedOn:date}).R[0];
      expect(Math.abs(r.flow-(r.inc+r.sAvailable-r.totE))).toBeLessThanOrEqual(1);
    }
  });
  it('does not report zero closing risk for a purchase outside the simulation',()=>{
    expect(M.runMonteCarlo({...D,homePurchaseYear:2100},3).dpFailPct).toBe(null);
  });
  it('inflates childcare without requiring the NYC budget preset',()=>{
    const p={...D,observedOn:null,nycFamilyBudget:false,numKids:1,kid1Birth:2027,childcareStartMonths:0,childcareMonthly:3000,expenseInflation:.03};
    expect(M.run(p).R.find(r=>r.yr===2027).ccFull).toBe(37080);
  });
  it('uses taxable income before QBI and both SSTB limitations',()=>{
    const p={...D,housingMode:'rent',taxInflation:0,pretax401k:0,pretaxBenefits:0,_normW2:370000,_nancyW2:0,_nancySE:150000};
    const t=M.calcTax(520000,p,2026,0);
    const halfSE=.5*(150000*.9235*(.124+.029));
    const before=520000-halfSE-t.deduction;
    const eligible=1-(before-403500)/150000;
    expect(t.qbi).toBe(Math.round((150000-halfSE)*.2*eligible**2));
  });
  it('honors the active-business QBI minimum and income limit',()=>{
    const p={...D,housingMode:'rent',taxInflation:0,pretax401k:0,pretaxBenefits:0,_normW2:0,_nancyW2:0,_nancySE:1500};
    expect(M.calcTax(1500,p,2026,0).qbi).toBe(400);
    expect(M.calcTax(1500,{...p,nancyQBIRate:0},2026,0).qbi).toBe(0);
  });
  it('includes NY supplemental recapture at the household peak income',()=>{
    const p={...D,housingMode:'rent',pretax401k:0,pretaxBenefits:0,_normW2:750000,_nancyW2:0,_nancySE:0};
    for(const year of [2026,2027,2040])
      expect(M.calcTax(750000,p,year,0).state).toBeCloseTo((750000-16050)*.0685,0);
  });
  it('phases NY supplemental tax in across its $50k AGI range',()=>{
    const p={...D,housingMode:'rent',pretax401k:0,pretaxBenefits:0,_normW2:348200,_nancyW2:0,_nancySE:0};
    const t=M.calcTax(348200,p,2026,0);
    const table=17928.34+(348200-16050-323200)*.0685;
    expect(t.state).toBeCloseTo(table+1140+3071/2,0);
  });
});
