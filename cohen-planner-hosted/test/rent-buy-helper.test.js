import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const M=require('../public/model.js');
const RB=require('../public/rent-buy.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
const plan={...D,observedOn:null,planStartYear:2026,homePurchaseYear:2030};

describe('rent-or-buy helper',()=>{
 it('runs both cases with rent rising before the purchase, without touching the saved plan',()=>{
  const s=RB.scenarios(plan);
  expect(s.buy.housingMode).toBe('buy');expect(s.rent.housingMode).toBe('rent');
  expect(s.buy.rentInflatesBeforePurchase).toBe(true);
  expect(plan.rentInflatesBeforePurchase).toBeUndefined();
  const flat=M.run(plan).R.find(r=>r.yr===2029),risen=M.run(s.buy).R.find(r=>r.yr===2029);
  expect(risen.hFull).toBe(flat.hFull);
  expect(risen.hFull).toBeGreaterThan(plan.nycRent*12);
  // Before the purchase the two cases are the same household.
  const c=RB.compare(plan,M.run);
  for(const r of c.rows.filter(r=>r.yr<2030)){expect(r.buy).toBe(r.rent);expect(r.buyOut).toBe(r.rentOut)}
 });
 it('judges buying after the cost of selling, and the gap attribution sums exactly',()=>{
  const c=RB.compare(plan,M.run,{sellCostPct:.07});
  const at=c.rows.find(r=>r.yr===c.horizon);
  expect(at.saleCost).toBe(Math.round(at.buyPaper-at.buy));
  expect(c.verdict.edge).toBe(at.buy-at.rent);
  expect(c.attribution.reduce((t,a)=>t+a.value,0)).toBe(c.verdict.edge);
  expect(RB.compare(plan,M.run,{sellCostPct:0}).verdict.edge).toBe(at.buyPaper-at.rent);
 });
 it('itemises the purchase year: closing, tax on what is sold, cash to close',()=>{
  const u=RB.compare(plan,M.run).upfront;
  expect(u.down).toBe(plan.homePrice*plan.downPctg/100);
  expect(u.cashToClose).toBe(u.down+u.closing);
  expect(u.investmentTax).toBeGreaterThan(0);
 });
 it('reads cash flow as cumulative spending including the cash to close',()=>{
  const c=RB.compare(plan,M.run,{lens:'cashflow'});
  const at=c.rows.find(r=>r.yr===c.horizon);
  expect(c.verdict.lens).toBe('cashflow');
  expect(c.verdict.edge).toBe(at.rentCum-at.buyCum);
  const buyYear=c.rows.find(r=>r.yr===2030);
  expect(buyYear.buyOut-buyYear.rentOut).toBeGreaterThanOrEqual(c.upfront.cashToClose);
 });
 it('levers move the answer the way they should',()=>{
  const e=p=>RB.compare(p,M.run).verdict.edge;
  expect(e({...plan,homeAppreciation:.06})).toBeGreaterThan(e(plan));
  expect(e({...plan,investReturn:.09})).toBeLessThan(e(plan));
  expect(e({...plan,mortgageRate:3})).toBeGreaterThan(e({...plan,mortgageRate:7}));
  expect(e(RB.withStripeShift(plan,.03))).toBeLessThan(e(plan));
  const sh=RB.withStripeShift(plan,.02);
  expect(sh.stripeRetY0).toBeCloseTo(plan.stripeRetY0+.02);expect(sh.stripeLongTermReturn).toBeCloseTo((plan.stripeLongTermReturn??.08)+.02);
 });
 it('finds the appreciation at which the answer flips, and says when nothing flips it',()=>{
  const f=RB.flipPoint(plan,M.run,'homeAppreciation',-.03,.10);
  expect(f.value).toBeGreaterThan(-.03);expect(f.buyAbove).toBe(true);
  const at=v=>RB.compare({...plan,homeAppreciation:v},M.run).verdict.edge;
  expect(Math.sign(at(f.value-.002))).not.toBe(Math.sign(at(f.value+.002)));
  const none=RB.flipPoint({...plan,homeAppreciation:.15},M.run,'mortgageRate',2,10);
  expect(none.value).toBe(null);expect(none.alwaysBuy).toBe(true);
 });
 it('a break-even is a year buying stays ahead from, not a passing crossing',()=>{
  const rows=[{yr:1,edge:-1},{yr:2,edge:1},{yr:3,edge:-1},{yr:4,edge:2},{yr:5,edge:3}];
  expect(RB.breakevenYear(rows,1,5)).toBe(4);
  expect(RB.breakevenYear(rows,1,3)).toBe(null);
 });
 it('is a Decisions view, served to the page, and explores without saving',()=>{
  // Rent or buy is the top of the merged Home screen, and the old view key still lands there.
  expect(html).toContain("['housing','home','Home']");
  expect(html).toContain("if(_homeView==='housing'||_homeView==='rentbuy'){renderHomeTab(R,P);return}");
  expect(html).toContain("renderRentBuyTab(R,P,'homeRB');");
  expect(html).toContain('<script src="/rent-buy.js"></script>');
  expect(server).toContain("'rent-buy.js'");
  const fn=html.slice(html.indexOf('function rbSet('),html.indexOf('function rbApply('));
  expect(fn).not.toMatch(/savePlannerState|P\[k\]=/);
  const apply=html.slice(html.indexOf('function rbApply('),html.indexOf('function renderRentBuyTab('));
  expect(apply).toContain('showConfirm');expect(apply).toMatch(/k!=='stripeShift'&&k!=='sellCost'/);
 });
});
