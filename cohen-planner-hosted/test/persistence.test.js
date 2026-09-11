import { describe,it,expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'module';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('let _saveTimer=null;'),html.indexOf('// Saved-state migration lives in'));
function harness(fetch){
  const statuses=[];let timer;
  // Everything savePlannerState() serialises has to exist here or the payload throws before
  // the status handling under test ever runs. Keep this in step with the payload's state
  // object — a missing view-state global surfaces as "X is not defined", not a save failure.
  const planState={P:{homePrice:2000000},compareMode:false,activeTab:'home',
    _projView:'nw',_todayView:'plan',_homeView:'explore',cockpitExRet:false,
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

// Every <script src> in index.html must have a matching authenticated route in server.js.
// liquidity.js shipped with a script tag and no route, so it 404'd in production while
// working locally under the preview server's plain static handler.
describe('Every front-end asset the page asks for is actually served',()=>{
  it('has a route for each local script and stylesheet',()=>{
    const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
    const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
    const refs=[...html.matchAll(/(?:src|href)="\/([\w.-]+\.(?:js|css))"/g)].map(m=>m[1]);
    expect(refs.length).toBeGreaterThan(5);
    for(const ref of refs)
      expect(server,`${ref} is referenced by index.html but has no route in server.js`)
        .toContain(`'${ref}'`);
  });
});

// The design system is only a system if there is exactly one of it. These lock the two
// rules that were actually broken: five money formats on one page, and emoji in chrome.
describe('One design system',()=>{
  const UI=createRequire(import.meta.url)('../public/ui.js');

  it('formats money by one rule at every magnitude',()=>{
    expect(UI.money(1630000)).toBe('$1.63M');
    expect(UI.money(127000)).toBe('$127K');
    expect(UI.money(16000)).toBe('$16K');
    expect(UI.money(4500)).toBe('$4,500');
    expect(UI.money(2000000)).toBe('$2M');          // trailing .00 is noise
    expect(UI.money(-250000)).toBe('−$250K');        // true minus, not a hyphen
    expect(UI.money(1200,{signed:true})).toBe('+$1,200');
  });

  it('returns a dash for a missing value rather than a readable zero',()=>{
    for(const v of [null,undefined,NaN,'',{}])expect(UI.money(v)).toBe('—');
    expect(UI.money(0)).toBe('$0');                  // a real zero still shows
  });

  it('never blanks the hero: the plan stands in and the chip carries the doubt',()=>{
    const live=UI.heroValue({observed:1800000,projected:1630000,complete:true});
    expect(live.value).toBe(1800000);
    expect(live.source).toBe('observed');

    const down=UI.heroValue({observed:null,projected:1630000});
    expect(down.value).toBe(1630000);                // a number, not a dash
    expect(down.source).toBe('projected');
    expect(down.note).toMatch(/unavailable/);

    const partial=UI.heroValue({observed:900000,projected:1630000,complete:false});
    expect(partial.partial).toBe(true);
    expect(partial.note).toMatch(/short by an unknown amount/);

    // Only when nothing at all is known does it give up, and it says so.
    expect(UI.heroValue({}).value).toBe(null);
  });

  it('draws icons from a closed set, and nothing for an unknown name',()=>{
    expect(UI.icon('bell')).toMatch(/^<svg class="ui-icon"/);
    expect(UI.icon('bell')).toContain('viewBox="0 0 20 20"');
    expect(UI.icon('no-such-icon')).toBe('');
  });

  it('keeps emoji out of the interface chrome',()=>{
    const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
    const nav=html.slice(html.indexOf('const SUB_VIEWS'),html.indexOf('let _stressMode'));
    // Pictographs in a sub-nav label render differently on every platform and cannot be
    // recoloured. The geometric glyphs in the main nav are deliberate and stay.
    expect(nav).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(nav).toContain("'bell'");
  });

  it('escapes provenance labels rather than trusting them',()=>{
    expect(UI.prov('observed','<script>')).toContain('&lt;script&gt;');
    expect(UI.prov('nonsense')).toContain('data-prov="missing"');
  });
});

// The trajectory is a control, not a picture. These lock the two judgements in it.
describe('Trajectory milestones',()=>{
  const src=fs.readFileSync(new URL('../public/cockpit.js',import.meta.url),'utf8');

  it('only marks a low point when the plan actually breaches its floor',()=>{
    // With the retention policy holding the pool exactly on its reserve floor, dozens of
    // years tie at the minimum and "the low point" is whichever one the reduce kept. A
    // pin there points at nothing.
    expect(src).toContain('floor.liq<reserve-1');
    expect(src).toMatch(/Only a genuine breach gets marked/);
  });

  it('lets the risk pin claim its year rather than being absorbed into a life event',()=>{
    expect(src).toContain('pins.unshift(');
  });

  it('caches the confidence band against the plan it was computed from',()=>{
    // A band drawn over a changed plan is worse than no band.
    expect(src).toContain('_cpBandSig');
    expect(src).toMatch(/stale band drawn over a changed plan/);
  });

  it('moves the hero with the scrub only while the hero is projected',()=>{
    // An observed balance belongs to today; relabelling it as 2041's would be a lie.
    expect(src).toContain("hero.dataset.source==='projected'");
  });
});

// The side rail carries ambient state, which is exactly where a reassuring lie is
// easiest to tell. These lock the two places it could.
describe('The live nav rail',()=>{
  const src=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const fn=src.slice(src.indexOf('function renderNavLive()'),src.indexOf('function setTab(t){'));

  it('never draws a zero badge, because zero and absent look identical to a reader',()=>{
    expect(fn).toContain('if(open){badge.hidden=false');
    expect(fn).toMatch(/only a real count\s*\n?\s*\/\/ is ever drawn/);
  });

  it('hides the badge entirely until the watchlist has actually loaded',()=>{
    // `_inbox` null must not become 0 — an unchecked plan is not a clear one.
    expect(fn).toContain('_inbox&&_inbox.counts?Number(_inbox.counts.open)||0:null');
  });

  it('states freshness in three honest tones rather than implying a sync',()=>{
    expect(fn).toContain("'Accounts not connected'");
    expect(fn).toMatch(/days>7\?'stale'/);
    expect(fn).toMatch(/Balances \$\{days\} day/);
  });

  it('hides the rail rather than drawing a curve it could not compute',()=>{
    expect(fn).toContain('catch(e){rail.hidden=true;return}');
  });

  it('is redrawn on every render, so a finished sync reaches it',()=>{
    expect(src).toContain('try{renderNavLive()}catch(e){}');
  });
});
