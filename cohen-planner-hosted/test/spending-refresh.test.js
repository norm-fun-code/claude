import {it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const src=html.slice(html.indexOf('async function loadSpending(){'),html.indexOf('\nasync function startBackfill('));
it('queues a fresh rollup when import completion races an older load',async()=>{
  const pending=[];let calls=0;
  const c=vm.createContext({_demoMode:false,_spendLoading:false,_spendRefreshPending:false,_spend:null,_syncStatus:null,activeTab:'today',_todayView:'spending',renders:0,render(){c.renders++},fetch(){calls++;return new Promise(resolve=>pending.push(resolve))}});
  vm.runInContext(src,c);
  const first=c.loadSpending();
  expect(calls).toBe(2);
  await c.loadSpending(); // completion notification while the old read is pending
  expect(calls).toBe(2);
  for(const resolve of pending.splice(0))resolve({ok:true,json:async()=>({coverage:'old'})});
  for(let i=0;i<12&&calls<4;i++)await Promise.resolve();
  expect(calls).toBe(4);
  for(const resolve of pending.splice(0))resolve({ok:true,json:async()=>({coverage:'verified'})});
  await first;
  expect(c._spend.coverage).toBe('verified');
  expect(c._syncStatus.coverage).toBe('verified');
  expect(c._spendLoading).toBe(false);
  expect(c._spendRefreshPending).toBe(false);
  expect(c.renders).toBe(1);
});
