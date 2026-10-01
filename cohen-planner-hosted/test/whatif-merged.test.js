import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const dr=fs.readFileSync(new URL('../public/decision-room.js',import.meta.url),'utf8');
describe('Explore and Key levers are one What-if screen',()=>{
 it('has one view, with the old keys landing on it',()=>{
  expect(html).toContain("['explore','spark','What-if']");
  expect(html).not.toContain("['levers','chart','Key levers']");
  expect(html).toContain("_homeView==='levers'?'explore'");
  expect(html).toContain("renderWhatIfTab(R,P);return;");
 });
 it('draws the what-if above the ranking, each into its own element, so neither erases the other',()=>{
  const fn=html.slice(html.indexOf('function renderWhatIfTab('),html.indexOf('let _slHost=null;'));
  expect(fn).toContain("renderDecisionRoom(R,'wiDR');");expect(fn).toContain("renderSensitivityTab(R,P,'wiKL');");
  expect(fn.indexOf("renderDecisionRoom")).toBeLessThan(fn.indexOf("renderSensitivityTab"));
  expect(dr).toContain("document.getElementById(_drHost).innerHTML=");
  expect(html).toContain("const ca=document.getElementById(_slHost||'chartArea');");
  expect(html).toContain("if(!_slHost)destroyCharts();");
 });
 it('drops the timeline and context fold that repeated the Cockpit chart and floor',()=>{
  expect(dr).not.toContain('decisionContextFold');expect(dr).not.toContain('Life & money timeline');
  expect(dr).toContain("if(document.getElementById('decisionChart'))decisionRenderChart(");
  expect(dr).toContain("if(yd)yd.innerHTML=");
 });
});
