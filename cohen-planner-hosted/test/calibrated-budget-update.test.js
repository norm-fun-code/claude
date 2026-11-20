import {it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import M from '../public/model.js';
import Update from '../calibrated-budget-update.js';

const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const defaults=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
const item=(sid,from,amount)=>({sid,label:sid,category:'oneoff',from,to:from,amount,grow:false});
const p={...defaults,kid1Birth:2027,kid2Birth:2029,kid3Birth:2032,kid4Birth:2036,numKids:4,
  childcareInflation:0,childcareMonthly:3800,childcareStartMonths:8,expenseInflation:0,
  homePurchaseYear:2031,locationConfig:{mode:'deal',moveYear:2031},
  livingUtilitiesY1:2000,livingClothingY2:7176,expenseAdjY1:20000,
  planItems:[item('home-furnish-2030',2030,30000),item('home-furnish-2031',2031,30000),
    item('baby-gear-2-2030',2030,6000),item('baby-gear-2-2029',2029,6000),item('baby-gear-3-2034',2034,6000)]};
it('calibrates the audited household once, retaining unrelated edits and the unclassified adjustment',()=>{
  const q=Update.updatePlan(p);
  expect(q.nycFamilyBudget).toBe(true);
  expect(q.livingClothingY2).toBe(7176);
  expect(q.livingUtilitiesY1).toBeUndefined();
  expect(q.expenseAdjY1).toBe(20000);
  expect(Update.updatePlan(q)).toBe(q);
  expect(Update.updatePlan(defaults)).toBe(defaults);
  expect(Update.updatePlan({...p,baseGroceries:9600}).baseGroceries).toBe(9600);
  expect(q.planItems.filter(i=>i.child===4)).toHaveLength(3);
});
it('splits York at the year boundary, estimates the bridge, and avoids charging care in the school year',()=>{
  const q=Update.updatePlan(p);
  const amounts=M.run({...q,numKids:1}).R;
  const care=y=>amounts.find(r=>r.yr===y).ccFull;
  expect(care(2027)).toBe(15200);
  expect(care(2028)).toBe(22800+11400);
  expect(care(2029)).toBe(22800);
  expect(care(2030)).toBe(0);
});
it('moves a scheduled cost when its birth or purchase year moves and omits unplanned kids',()=>{
  const q=Update.updatePlan(p);
  expect(M.planItemsFor(q,2030).oneOff).toBe(0);
  expect(M.planItemsFor(q,2031).oneOff).toBe(30000);
  expect(M.planItemsFor({...q,homePurchaseYear:2035},2035).oneOff).toBe(30000);
  expect(M.planItemsFor(q,2032).oneOff).toBe(6000);
  expect(M.planItemsFor({...q,numKids:2},2032).oneOff).toBe(0);
  expect(M.planItemsFor({...q,kid3Birth:2033},2033).oneOff).toBe(6000);
});
