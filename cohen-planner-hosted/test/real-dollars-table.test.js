import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const M=require('../public/model.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const D=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
const keys=eval(html.match(/const _REAL_KEYS=(\[[^\]]+\]);/)[1]);
const mk=(inflationView)=>new Function('inflationView','P',html.slice(html.indexOf('function deflateRow('),html.indexOf('\n}\n',html.indexOf('function deflateRow('))+3).replace(/^/,'const _REAL_KEYS='+JSON.stringify(keys)+';')+';return deflateRow;')(inflationView,{...D,planStartYear:2026});
const R=M.run({...D,planStartYear:2026,observedOn:null}).R;

describe('the Table in today\'s dollars',()=>{
 it('is the same row when Real $ is off, and a scaled copy when it is on',()=>{
  expect(mk(false)(R[5])).toBe(R[5]);
  const real=mk(true)(R[12]),f=1/1.03**12;
  expect(real.groceries).toBeUndefined();
  expect(real.totEFull).toBe(Math.round(R[12].totEFull*f));
  expect(real.livFullParts.groceries).toBe(Math.round(R[12].livFullParts.groceries*f));
  expect(R[12].totEFull).toBeGreaterThan(real.totEFull);          // the source is untouched
  expect(real.effRate).toBe(R[12].effRate);expect(real.yr).toBe(R[12].yr);
 });
 it('leaves the first year alone, and keeps the parts adding to the total',()=>{
  expect(mk(true)(R[0]).totEFull).toBe(R[0].totEFull);
  const d=mk(true);
  for(const r of R){const x=d(r);const sum=x.hFull+Object.values(x.livFullParts).reduce((t,v)=>t+v,0)+x.ccFull+x.tuFull+x.eAdj;expect(Math.abs(sum-x.totEFull),String(r.yr)).toBeLessThanOrEqual(13)}
 });
 it('has the Nominal / Real toggle on the Table, and the table and breakdown read the scaled rows',()=>{
  expect(html).toContain("if(activeTab==='projection'){\n      chartOpts=opt('inflBtn'");
  expect(html).toContain('R.map(r0=>{\n      const r=deflateRow(r0);');
  expect(html).toContain("<strong>today's dollars</strong>");
 });
 it('treats a figure typed in real dollars as real, storing the year\'s own dollars',()=>{
  const fn=html.slice(html.indexOf('function expCatSet('),html.indexOf('function expCatReset('));
  expect(fn).toContain('const n=inflationView?Math.round(typed*Math.pow(1+(P.expenseInflation||.03),yr-(P.planStartYear||2026))):typed;');
 });
 it('shows a per-month figure beside each part and each living line',()=>{
  const fn=html.slice(html.indexOf('function expDetailRow('),html.indexOf('function expAdjSet('));
  expect((fn.match(/class="exp-mo"/g)||[]).length).toBeGreaterThanOrEqual(4);
  expect(fn).toContain("fmtF(Math.round(v/12))}/mo");
 });
});
