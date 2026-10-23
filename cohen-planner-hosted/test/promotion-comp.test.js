import {describe,it,expect} from 'vitest';
import Comp from '../promotion-comp-scenarios.js';
describe('approved March promotion compensation',()=>{
 it('keeps 2027 bonuses at L3 Exceeds and pays ten months at L4 salary',()=>{
  for(const key of ['base','optimistic'])expect(Comp.schedule(key)[0]).toEqual({year:2027,cash:271250,stock:175000});
 });
 it('lags the two Meets ratings into 2029 and 2030 awards',()=>{
  const rows=Comp.schedule('base');
  expect(rows[1].stock).toBe(183438);
  expect(rows[2].stock).toBe(182500);
  expect(rows[3].stock).toBe(169063);
 });
 it('preserves six/five year promotion intervals and zero-appreciation overlapping PEGs',()=>{
  expect(Comp.schedule('base').find(r=>r.year===2033).stock).toBe(247500);
  expect(Comp.schedule('optimistic').find(r=>r.year===2032).stock).toBe(243438);
 });
 it('patches only future compensation and preserves 2026, household and valuation assumptions',()=>{
  const original={planStartYear:2026,normCashY0:257000,normStockY0:155000,homePrice:2000000,stripeRetY0:.07,baseGroceries:14400,stripeManualLater:{2037:{cash:1,stock:2,note:'keep'}}};
  const frozen=JSON.stringify(original),next=Comp.patchComp(original,'base');
  expect(JSON.stringify(original)).toBe(frozen);
  for(const key of ['normCashY0','normStockY0','homePrice','stripeRetY0','baseGroceries'])expect(next[key]).toBe(original[key]);
  expect(next.normCashY1).toBe(271250);
  expect(next.stripeManualLater[2037].note).toBe('keep');
  expect(next.stripeManualLater[2037].stock).toBe(268750);
 });
 it('rejects Conservative rather than silently changing it',()=>{
  expect(()=>Comp.patchComp({},'conservative')).toThrow();
 });
});
