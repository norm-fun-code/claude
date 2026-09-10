import { describe,it,expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('let _saveTimer=null;'),html.indexOf('// Saved-state migration lives in'));
function harness(fetch){
  const statuses=[];let timer;
  // Everything savePlannerState() serialises has to exist here or the payload throws before
  // the status handling under test ever runs. Keep this in step with the payload's state
  // object — a missing view-state global surfaces as "X is not defined", not a save failure.
  const planState={P:{homePrice:2000000},compareMode:false,activeTab:'home',
    _projView:'nw',_todayView:'plan',_homeView:'explore',
    activeScenarioIdx:-1,scenarioDirty:false,monarchSnapshot:null};
  const ctx=vm.createContext({fetch,JSON,Promise,Error,...planState,
    setSyncStatus:s=>statuses.push(s),setTimeout:fn=>{timer=fn;return 1;},clearTimeout:()=>{timer=null;}});
  vm.runInContext(source,ctx);
  return{ctx,statuses,call:code=>vm.runInContext(code,ctx),flush:()=>timer?.()};
}
describe('Plan persistence',()=>{
  it('does not report synced on HTTP failure, and a later save can recover',async()=>{
    let ok=false;
    const h=harness(async()=>({ok,status:ok?200:503}));
    h.call('_planLoaded=true;savePlannerState()');h.flush();await h.call('_saveQueue');
    expect(h.statuses.at(-1)).toBe('error');
    expect(h.statuses).not.toContain('synced');
    ok=true;h.call('savePlannerState()');h.flush();await h.call('_saveQueue');
    expect(h.statuses.at(-1)).toBe('synced');
  });
  it('serializes writes and suppresses stale completion status',async()=>{
    const writes=[];let completeFirst;
    const h=harness(async(_url,options)=>{
      writes.push(JSON.parse(options.body).state.P.homePrice);
      if(writes.length===1)await new Promise(resolve=>{completeFirst=resolve;});
      return{ok:true};
    });
    h.call('_planLoaded=true;savePlannerState()');h.flush();
    await Promise.resolve();await Promise.resolve();
    h.call('P={homePrice:1800000};savePlannerState()');h.flush();
    expect(writes).toEqual([2000000]);
    completeFirst();await h.call('_saveQueue');
    expect(writes).toEqual([2000000,1800000]);
    expect(h.statuses.filter(s=>s==='synced')).toHaveLength(1);
  });
  it('will not overwrite the server with defaults after a failed initial load',async()=>{
    let called=false;const h=harness(async()=>{called=true;return{ok:true};});
    h.call('savePlannerState()');h.flush();await h.call('_saveQueue');
    expect(called).toBe(false);expect(h.statuses.at(-1)).toBe('error');
  });
});
