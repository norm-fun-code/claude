import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../public/cockpit.js',import.meta.url),'utf8');
const fn=src.slice(src.indexOf('function mountSpendingCharts('));
const body=fn.slice(0,fn.indexOf('\n}\n')+3);

describe('spending charts: hovering a point works',()=>{
 it('runs every tooltip callback without a missing helper',()=>{
  const configs=[];
  class Chart{constructor(el,cfg){configs.push(cfg)}}
  const ctx={Chart,charts:{},fmt:v=>'$'+v,fmtF:v=>'$'+v,monthLabel:m=>m,
   document:{getElementById:()=>({getContext:()=>({}),style:{},closest:()=>({style:{}}),after(){},insertAdjacentElement(){},appendChild(){},parentNode:{appendChild(){}}}),createElement:()=>({})},
   PlannerSpending:{rollingSeries:m=>m.map(()=>({income:1000,expense:800}))}};
  ctx.window=ctx;
  vm.createContext(ctx);
  // Run it for real, with the chart library stubbed; any identifier it needs but does not have throws here.
  const months=[{month:'2025-12',income:1000,expense:800},{month:'2026-01',income:1000,expense:800},{month:'2026-02',income:1000,expense:800}];
  vm.runInContext(body+`;mountSpendingCharts({rows:[],months:${JSON.stringify(months)},asOf:'2026-02-10',verified:['2025-12','2026-01','2026-02']});`,ctx);
  let ran=0;
  for(const c of configs){
   const cb=c?.options?.plugins?.tooltip?.callbacks||{};
   if(cb.label){expect(()=>cb.label({raw:1234,dataset:{label:'Spending'},label:'x'})).not.toThrow();ran++}
  }
  expect(ran).toBe(2);
 });
});
