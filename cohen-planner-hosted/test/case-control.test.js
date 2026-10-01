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
