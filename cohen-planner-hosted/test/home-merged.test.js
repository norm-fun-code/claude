import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
describe('Housing and Rent or buy are one Home screen',()=>{
 it('has one Home view, which the old keys still reach',()=>{
  expect(html).toContain("['housing','home','Home']");
  expect(html).not.toContain("['rentbuy','arrow','Rent or buy']");
  expect(html).toContain("home:{get:()=>_homeView==='rentbuy'?'housing':_homeView");
  expect(html).toContain("if(t==='housing'||t==='rentbuy'||t==='sensitivity'||t==='compare')");
 });
 it('renders both halves into one page, without one tearing down the other\'s chart',()=>{
  const home=html.slice(html.indexOf('function renderHomeTab('),html.indexOf('function renderHousingTab('));
  expect(home).toContain("renderRentBuyTab(R,P,'homeRB');");expect(home).toContain("renderHousingTab(R,P,'homeHS');");
  expect(home.indexOf("renderRentBuyTab(R,P,'homeRB')")).toBeLessThan(home.indexOf("renderHousingTab(R,P,'homeHS')"));
  expect(html).toContain("if(!host)destroyCharts();");
  expect((html.match(/if\(!host\)destroyCharts\(\);/g)||[]).length).toBe(2);
 });
 it('has one set of levers and one Apply: affordability reads the rent-or-buy overrides',()=>{
  expect(html).toContain('function afParams(){return rbParams()}');
  expect(html).not.toContain('_afRate');expect(html).not.toContain('function afApply');
  const housing=html.slice(html.indexOf('function renderHousingTab('),html.indexOf('function updateRefiCalc'));
  for(const gone of ["lever('afRate'","lever('afDown'","lever('afYear'",'onclick="afApply()"'])expect(housing).not.toContain(gone);
  expect(housing).toContain("lever('afShare'");
 });
 it('keeps what was asked to stay: rates grid, monthly cost cards, refinance, readiness, payoff',()=>{
  const housing=html.slice(html.indexOf('function renderHousingTab('),html.indexOf('function updateRefiCalc'));
  for(const kept of ['Compare mortgage rates & down payments','Monthly cost at','Refinance break-even calculator','housingReadinessHtml(R,P)','mortgagePayoffHtml(R,P)','Can the cash be there?'])
   expect(housing).toContain(kept);
 });
 it('says what moving the purchase year does before applying it',()=>{
  expect(html).toContain('Moving the purchase year shifts the down payment, and every year of the plan after it.');
 });
});
