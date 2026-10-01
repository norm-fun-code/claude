import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const between=(a,b)=>{const i=html.indexOf(a);return html.slice(i,html.indexOf(b,i))};

describe('the Goals tab is gone and each part has a home',()=>{
 it('is no longer a Financial life view, and old links still land somewhere',()=>{
  expect(html).not.toContain('function renderGoalsTab');
  expect(html).not.toContain("['plan','target','Goals']");
  expect(html).toContain("if(t==='goals'){_todayView='budget';t='today';}");
  // A saved plan that remembers the old view falls back to Accounts rather than a blank screen.
  expect(html).toContain("    else renderOverviewTab(R,P);");
 });
 it('puts down-payment readiness and the mortgage payoff with the home',()=>{
  const housing=between('function renderHousingTab(','\nfunction renderRentBuyTab').length?between('function renderHousingTab(','\nfunction '):'';
  expect(html).toContain('function housingReadinessHtml(R,P)');
  expect(html).toContain('function mortgagePayoffHtml(R,P)');
  expect(html).toContain('h+=housingReadinessHtml(R,P);');
  expect(html).toContain('h+=mortgagePayoffHtml(R,P);');
  // The old card closed a <details> inside a loop, thirty times over.
  expect(between('function mortgagePayoffHtml(','function renderHousingTab(')).not.toMatch(/<\/div><\/details>`;\s*\}\)\.join/);
 });
 it('keeps tuition with the shape of the plan, in the Over time section below the lines',()=>{
  expect(html).toContain('function budgetTuitionHtml(R,P)');
  const render=html.slice(html.indexOf('function renderBudgetTab('));
  expect(render).toContain('const tuitionHtml=budgetTuitionHtml(R,P);');
  const over=render.slice(render.indexOf('const overTimeHtml='),render.indexOf('const scenarioFold='));
  expect(over.indexOf('${phasesHtml}')).toBeGreaterThan(-1);
  expect(over.indexOf('${phasesHtml}')).toBeLessThan(over.indexOf('${tuitionHtml}'));
 });
 it('puts risk and confidence under the net-worth chart, once',()=>{
  expect(html).toContain('function riskFoldHtml()');
  expect(html).toContain("(activeTab==='projection'&&_projView==='nw'?riskFoldHtml():'')");
  expect((html.match(/id="goalsRiskOut"/g)||[]).length).toBe(1);
 });
 it('keeps the parts that were asked to stay: refinance, rates grid, monthly cost cards',()=>{
  expect(html).toContain('Refinance break-even calculator');
  expect(html).toContain('Compare mortgage rates &amp; down payments'.replace('&amp;','&'));
  expect(html).toMatch(/Monthly cost at \$\{/);
 });
 it('drops what duplicated other screens: liquid-health bars and the editable kid chips',()=>{
  expect(html).not.toContain('Liquid Health Over Time');
  expect(html).not.toContain('function goalInlineEl');
 });
});
