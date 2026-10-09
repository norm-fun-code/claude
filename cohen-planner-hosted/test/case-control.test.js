import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const cockpit=fs.readFileSync(new URL('../public/cockpit.js',import.meta.url),'utf8');
const fn=(name)=>{const a=html.indexOf('function '+name+'(');return html.slice(a,html.indexOf('\n}\n',a)+3)};

describe('the case control in the header',()=>{
 it('is in the header on every screen, with the one save button for a case',()=>{
  expect(html).toContain('<div id="caseControl" class="case-ctl"></div>');
  const render=fn('renderCaseControl');
  expect(render).toContain('class="case-save"');
  expect(render).toContain('Save to “');
  expect(render).toContain('Discard edits');
  expect(render).toContain('Save as a new case…');
  expect(render).toContain('Overlay cases on charts');
 });
 it('shows the save button only when the case has been edited, and clears it after a save',()=>{
  expect(fn('renderCaseControl')).toMatch(/\$\{dirty\?`<button type="button" class="case-save"/);
  expect(html).toMatch(/function markDirty\(\)\{[\s\S]*?scenarioDirty=true;\s*renderCaseControl\(\);/);
  const upd=html.slice(html.indexOf('async function updateScenario('),html.indexOf('async function deleteScenario('));
  expect(upd).toContain('scenarioDirty=false');
  expect(upd).toContain('Could not save');            // a failed save says so, and the edits stay
  expect(upd).toContain('scenarioDirty=true;renderCaseControl()');
 });
 it('asks before leaving edits behind, and before deleting or discarding',()=>{
  expect(fn('caseLoad')).toContain('showConfirm(');
  expect(fn('caseLive')).toContain('showConfirm(');
  expect(fn('caseDiscard')).toContain('showConfirm(');
  expect(fn('caseDelete')).toContain('showConfirm(');
 });
 it('replaces the strip of tiny chips, the Inputs switcher and the form no screen showed',()=>{
  expect(html).not.toContain('id="scenarioBar"');
  expect(html).not.toContain('scenarioSaveArea');
  expect(html).not.toContain('function renderInputScenarioSwitcher');
  expect(html).not.toContain('function showSaveInput');
  expect(html).toContain('run:()=>caseNew()');           // the command palette still saves a new case
 });
 it('shows snapshot chips only above the chart they overlay',()=>{
  expect(fn('renderSnapshotBar')).toContain("activeTab!=='projection'||_projView!=='nw'");
 });
});

describe('chrome that was built and hidden',()=>{
 it('no longer builds a hero band or KPI strip nothing displayed',()=>{
  expect(html).not.toContain("getElementById('kpis')");
  expect(html).not.toContain('id="kpis"');
  expect(html).not.toContain('_hb.innerHTML');
 });
 it('drops the Cockpit shortcuts that repeat the tab bar, and unreachable code',()=>{
  expect(cockpit).not.toContain('Explore your plan');
  expect(html).not.toContain('function renderMonarchAccountsCard');
  expect(html).not.toContain('function renderStripeReconcile');
 });
});

// A menu that renders blank rows passed every check above, because none of them opened it with saved
// cases in it. This one runs the real function against real cases and reads what it draws.
describe('the case menu with saved cases in it',()=>{
 const src=html.slice(html.indexOf('function renderCaseControl('),html.indexOf('\n}\n',html.indexOf('function renderCaseControl('))+3);
 const draw=(extra)=>{
  const el={innerHTML:''};
  const scenarios=[{name:'Conservative',color:'#ecc183'},{name:"Ramit's Plan",color:'#845ef7'},{name:'<b>x</b>',color:'#fff'}];
  const ctx={document:{getElementById:()=>el},scenarios,activeScenarioIdx:1,scenarioDirty:false,compareMode:false,_caseMenu:true,_caseNaming:false,_archivedCases:[],advEscape:v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'),...extra};
  ctx.caseReallyEdited=()=>ctx.scenarioDirty;   // the real one compares plans; here the flag stands in for it
  new Function(...Object.keys(ctx),src+';renderCaseControl();')(...Object.values(ctx));
  return el.innerHTML;
 };
 it('names every case, and points each row at its own index',()=>{
  const out=draw();
  for(const n of ['Conservative','Ramit&#39;s Plan'.replace('&#39;',"'"),'&lt;b&gt;x&lt;/b&gt;'])expect(out).toContain('<span>'+n+'</span>');
  expect(out).toContain('onclick="caseLoad(0)"');expect(out).toContain('onclick="caseLoad(1)"');expect(out).toContain('onclick="caseLoad(2)"');
  expect(out).toContain('onclick="caseArchive(2)"');
  expect(out).not.toContain('[object Object]');expect(out).not.toContain('undefined');
 });
 it('marks the open case, escapes names, and offers Save only when edited',()=>{
  expect(draw()).toContain('<b>✓</b>');
  expect(draw()).not.toContain('<b>x</b>');
  expect(draw()).not.toContain('class="case-save"');
  const edited=draw({scenarioDirty:true});
  expect(edited).toContain('<b>edited</b>');expect(edited).toContain('class="case-save"');
 });
});

describe('recoverable case removal',()=>{
 it('retains the case on a failed archive and restores the saved assumptions on success',async()=>{
  const s={id:'case-a',name:'Old case',params:{combinedIncomeCap:750000}},scenarios=[s],archived=[];
  let ok=false,removed=0,body;
  const ctx={scenarios,_archivedCases:archived,fetch:async(_url,o)=>{body=JSON.parse(o.body);return{ok,status:503}},caseMenuClose:()=>{},deleteScenario:async(i,soft)=>{expect(soft).toBe(true);scenarios.splice(i,1);removed++},showToast:()=>{},run:x=>x,scenarioPlan:x=>x,renderCaseControl:()=>{},savePlannerState:()=>{}};
  const funcs=new Function(...Object.keys(ctx),'async '+fn('caseArchive')+'async '+fn('caseRestore')+';return {caseArchive,caseRestore};')(...Object.values(ctx));
  await funcs.caseArchive(0);expect(removed).toBe(0);expect(scenarios).toHaveLength(1);
  ok=true;await funcs.caseArchive(0);expect(scenarios).toHaveLength(0);expect(body.params._archived).toBe(true);
  await funcs.caseRestore(0);expect(scenarios[0].params).toEqual(s.params);expect(archived).toHaveLength(0);expect(body.params._archived).toBeUndefined();
 });
});

describe('EDITED reflects a real difference',()=>{
 const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 it('only believes the dirty flag while the plan differs from the case',()=>{
  expect(html).toContain('function caseReallyEdited()');
  const render=html.slice(html.indexOf('function renderCaseControl('));
  expect(render.slice(0,400)).toContain('caseReallyEdited()');
  expect(html).toMatch(/if\(same\)scenarioDirty=false/);
  // both switch-away warnings use the same truth, so they cannot nag about edits that are not there
  expect((html.match(/caseReallyEdited\(\)&&/g)||[]).length).toBeGreaterThanOrEqual(2);
 });
});
