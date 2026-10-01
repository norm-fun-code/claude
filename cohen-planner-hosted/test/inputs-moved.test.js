import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const stripe=fs.readFileSync(new URL('../public/stripe-grants-ui.js',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/ui.css',import.meta.url),'utf8');
const bc=html.slice(html.indexOf('function buildControls(){'),html.indexOf('\n}\n',html.indexOf('function buildControls(){'))+3);

describe('Inputs keeps what is an assumption about the household and the market',()=>{
 it('assembles only kids, plan start, Nancy and returns & inflation',()=>{
  const assembled=bc.slice(bc.indexOf("h+=ST('👶 Kids'"));
  expect(assembled).toContain("ST('👶 Kids'");expect(assembled).toContain("ST('📅 Plan Start Year'");
  expect(assembled).toContain("ST('👩‍⚕️ Nancy");expect(assembled).toContain("ST('📈 Returns & inflation'");
  for(const gone of ["ST('📦 Expenses","ST('🏠 Home'","ST('🍼 Childcare'","ST('🎓 Tuition'","ST('💼 Norm","ST('◆ Stripe Equity'"])
   expect(bc).not.toContain(gone);
 });
 it('keeps expense inflation, which is an assumption and not a line',()=>{
  expect(bc).toContain("s('Expense inflation','expenseInflation'");
  const returns=bc.slice(bc.indexOf('const retBody='),bc.indexOf('bodies.returns=retBody'));
  expect(returns).toContain("'expenseInflation'");
 });
 it('says where the rest went, with links',()=>{
  expect(bc).toContain('Looking for something?');
  expect(bc).toContain("_todayView='budget';setTab('today')");
  expect(bc).toContain("setTab('stripe')");
 });
 it('is reached from a gear in the header, which shows when it is the open screen',()=>{
  expect(html).toContain('id="inputsGear"');
  expect(html).not.toContain('data-tab="inputs"');
  expect(html).toContain("document.getElementById('inputsGear')?.classList.toggle('active',activeTab==='inputs')");
 });
});

describe('every control has one definition, wherever it is shown',()=>{
 it('keeps each section body by name and hands it to the screen that owns it',()=>{
  for(const k of ['childcare','tuition','home','baselines','oneOff','norm','stripe','kids','returns'])
   expect(bc).toContain('bodies.'+k+'=');
  expect(html).toContain('function embedControls(key)');
 });
 it('makes an embedded slider safe to drag: the label moves, the screen redraws on release',()=>{
  const fn=html.slice(html.indexOf('function embedControls('),html.indexOf('function U(key,val)'));
  expect(fn).toContain(`oninput="Upeek('$1',this.value)" onchange="U('$1',this.value)"`);
  expect(html).toContain('function Upeek(key,val){P[key]=parseFloat(val);sliderLabel(key)}');
  expect(fn).toContain('data-v="$1"');                       // no duplicate ids with the Inputs panel
 });
 it('lets Budget edit housing, childcare and tuition in place, and set one-off costs and baselines',()=>{
  const budget=html.slice(html.indexOf('function renderBudgetTab('));
  expect(budget).toContain("embedControls('home')");expect(budget).toContain('embedControls(k)');
  expect(budget).toContain("embedControls('oneOff')");
  expect(budget).toContain("embedControls('baselines')");
  expect(budget).toContain('Baselines the model starts from');
  expect(budget).toContain("<span class=\"bd-actions${o.readonly?' show':''}\">");   // Edit is never hidden
  expect(html).toContain('Home upkeep');
 });
 it('gives Stripe the compensation extras and equity assumptions Inputs used to hold',()=>{
  expect(stripe).toContain("['assumptions','Assumptions']");
  expect(stripe).toContain("embedControls('stripe')");
  expect(stripe).toContain("embedControls('norm')");
  expect(stripe).toContain("'assumptions'].includes(view)");
 });
 it('drops the year-by-year compensation grid Inputs repeated from Stripe > Compensation',()=>{
  expect(bc).not.toContain('comp-grid comp-head');
 });
});
