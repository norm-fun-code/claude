import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const cockpit=fs.readFileSync(new URL('../public/cockpit.js',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/cockpit.css',import.meta.url),'utf8');
const spend=html.slice(html.indexOf('function renderSpendingTab('),html.indexOf('\n}\n',html.indexOf('function renderSpendingTab('))+3);

describe('Spending: one lead card, the charts, and the plumbing out of the way',()=>{
 it('leads with the categories against income, with the period control on that card',()=>{
  expect(spend).toContain('const scopeNote=');
  const lens=html.slice(html.indexOf('function renderIncomeLens('),html.indexOf('function renderSpendingTab('));
  expect(lens).toContain('actualExtra.scopeControl');
  expect(lens).toContain('actualExtra.detailsHtml');
  expect(spend.indexOf('h+=renderIncomeLens(R,{rows,complete,cov,closedTotal,scopeControl,scopeNote,detailsHtml});')).toBeLessThan(spend.indexOf('class="spend-visuals"'));
 });
 it('drops the donut that showed the same categories without the income beside them',()=>{
  expect(spend).not.toContain('spendCategoryChart');
  expect(cockpit).not.toContain('spendCategoryChart');
  expect(cockpit).not.toContain('spendCategoryLegend');
 });
 it('folds import status, classification and the monthly ledger into one Data section',()=>{
  expect(spend).toContain('Data &amp; import');
  const fold=spend.slice(spend.indexOf('Data &amp; import'));
  expect(fold).toContain('${syncCard}');expect(fold).toContain('${classificationDetails}');expect(fold).toContain('${ledgerHtml}');
  // Until anything is imported the import card is the thing to do, so it leads.
  expect(spend).toContain('if(!(st.transactions||0)||d.error)h+=syncCard;');
 });
 it('lays the two charts side by side on a wide screen and one over the other on a narrow one',()=>{
  expect(css).toMatch(/\.spend-stack\{display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(0,1\.35fr\)/);
  expect(css).toMatch(/max-width:1000px\)\{\.spend-stack\{grid-template-columns:1fr\}/);
 });
 it('keeps Plan mode on the lens, untouched',()=>{
  const lens=html.slice(html.indexOf('function renderIncomeLens('),html.indexOf('function renderSpendingTab('));
  expect(lens).toContain("modeChip('plan','Plan')");expect(lens).toContain('Year to look at');
 });
});

describe('Tax-loss harvesting is a Watchlist signal',()=>{
 it('is built for the Watchlist, shown there, and gone from Holdings',()=>{
  expect(html).toContain('function taxLossHtml()');
  const watch=html.slice(html.indexOf('function renderWatchTab('),html.indexOf('\n}\n',html.indexOf('function renderWatchTab('))+3);
  expect(watch).toContain('h+=taxLossHtml();');
  const portfolio=html.slice(html.indexOf('function renderPortfolioTab('),html.indexOf('\n}\n',html.indexOf('function renderPortfolioTab('))+3);
  expect(portfolio).not.toContain('Tax-Loss Harvesting');
  expect(html).toContain("(_todayView==='holdings'||_todayView==='watch')");   // loads when the Watchlist is opened first
 });
 it('says what acting on it is worth and the catch',()=>{
  const fn=html.slice(html.indexOf('function taxLossHtml('),html.indexOf('function renderWatchTab('));
  expect(fn).toContain('wash-sale');expect(fn).toContain('save about');
 });
});
