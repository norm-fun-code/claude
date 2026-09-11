import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
const require=createRequire(import.meta.url);
const S=require('../public/inbox-state.js');

describe('A snooze comes back; a dismissal does not',()=>{
  it('refuses a snooze with no expiry, and says why',()=>{
    const r=S.validateAlertState({state:'snoozed',now:'2026-09-10'});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/dismissal/);
  });

  it('refuses an expiry already in the past',()=>{
    expect(S.validateAlertState({state:'snoozed',until:'2026-09-01',now:'2026-09-10'}).ok).toBe(false);
    expect(S.validateAlertState({state:'snoozed',until:'not a date',now:'2026-09-10'}).ok).toBe(false);
  });

  it('accepts a future expiry and normalises it',()=>{
    const r=S.validateAlertState({state:'snoozed',until:'2026-12-01',now:'2026-09-10'});
    expect(r.ok).toBe(true);
    expect(r.until).toBe('2026-12-01T00:00:00.000Z');
  });

  it('carries no expiry for the permanent states',()=>{
    for(const state of ['open','dismissed','resolved']){
      const r=S.validateAlertState({state,until:'2026-12-01',now:'2026-09-10'});
      expect(r.ok,state).toBe(true);
      expect(r.until,state).toBe(null);
    }
  });

  it('rejects a state it does not know',()=>{
    const r=S.validateAlertState({state:'ignored',now:'2026-09-10'});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/dismissed/);   // lists what is allowed
  });
});

describe('Where a figure came from decides whether it needs review',()=>{
  it('only a value the user typed can arrive confirmed',()=>{
    expect(S.startsReviewed('entered')).toBe(true);
    expect(S.startsReviewed('entered',true)).toBe(true);
    expect(S.startsReviewed('entered',false)).toBe(false);
  });

  it('an extracted value starts unreviewed however confident the caller is',()=>{
    for(const kind of ['vestPaystub','priorYearReturn','basisStatement','ocr','provider'])
      expect(S.startsReviewed(kind,true),kind).toBe(false);
  });
});

describe('Silence is not consent',()=>{
  const fields=[
    {field:'grossVest',value:197000},
    {field:'federalWithheld',value:43340},
    {field:'stateWithheld',value:23049},
  ];

  it('leaves every undecided field pending',()=>{
    const r=S.reviewDecisions(fields,{});
    expect(r.accept).toEqual([]);
    expect(r.pending).toHaveLength(3);
    expect(r.complete).toBe(false);
    expect(r.status).toBe('awaitingReview');
  });

  it('accepts only what was explicitly accepted',()=>{
    const r=S.reviewDecisions(fields,{grossVest:{accepted:true},stateWithheld:{accepted:false}});
    expect(r.accept.map(a=>a.field)).toEqual(['grossVest']);
    expect(r.reject).toEqual(['stateWithheld']);
    expect(r.pending).toEqual(['federalWithheld']);
    expect(r.complete).toBe(false);
  });

  it('takes a correction over the extracted value, and flags that it was corrected',()=>{
    const r=S.reviewDecisions(fields,{
      grossVest:{accepted:true,corrected:196500},
      federalWithheld:{accepted:true},
      stateWithheld:{accepted:true},
    });
    expect(r.accept[0]).toEqual({field:'grossVest',value:196500,corrected:true});
    expect(r.accept[1]).toEqual({field:'federalWithheld',value:43340,corrected:false});
    expect(r.complete).toBe(true);
    expect(r.status).toBe('reviewed');
  });

  it('treats a null correction as no correction, not as a zero',()=>{
    const r=S.reviewDecisions(fields,{grossVest:{accepted:true,corrected:null}});
    expect(r.accept[0].value).toBe(197000);
    expect(r.accept[0].corrected).toBe(false);
  });

  it('accepts an explicit zero as a real correction',()=>{
    const r=S.reviewDecisions(fields,{grossVest:{accepted:true,corrected:0}});
    expect(r.accept[0].value).toBe(0);
    expect(r.accept[0].corrected).toBe(true);
  });
});

describe('A failed briefing never leaves the old one looking current',()=>{
  const ready={status:'ready',generatedAt:'2026-09-08T06:00:00.000Z',complete:true,
    narrative:'…'};

  it('says plainly when there has never been one',()=>{
    const v=S.briefingView(null,null,'2026-09-10');
    expect(v.hasBriefing).toBe(false);
    expect(v.status).toBe('none');
  });

  it('reports a failure with no fallback as a failure, not as emptiness',()=>{
    const v=S.briefingView(null,{status:'failed',error:'Monarch timed out'},'2026-09-10');
    expect(v.status).toBe('failed-no-prior');
    expect(v.failing).toBe(true);
    expect(v.message).toMatch(/Monarch timed out/);
    expect(v.message).toMatch(/no earlier one/);
  });

  it('shows the last good briefing but marks it not current after a failure',()=>{
    const v=S.briefingView(ready,{status:'failed',error:'projection failed'},'2026-09-10');
    expect(v.hasBriefing).toBe(true);
    expect(v.status).toBe('stale-after-failure');
    expect(v.message).toMatch(/2026-09-08/);
    expect(v.message).toMatch(/this is not current/);
    expect(v.message).toMatch(/projection failed/);
  });

  it('never claims a two-day-old briefing is today\'s',()=>{
    const v=S.briefingView(ready,ready,'2026-09-10');
    expect(v.status).toBe('current');
    expect(v.ageDays).toBe(2);
    expect(v.message).toMatch(/2 days old/);
    expect(v.message).not.toMatch(/today/);
  });

  it('says "generated today" only on the day it was generated',()=>{
    const today={...ready,generatedAt:'2026-09-10T06:00:00.000Z'};
    expect(S.briefingView(today,today,'2026-09-10').message).toMatch(/generated today/);
  });

  it('keeps showing the old one while a new one runs',()=>{
    const v=S.briefingView(ready,{status:'pending'},'2026-09-10');
    expect(v.status).toBe('refreshing');
    expect(v.running).toBe(true);
    expect(v.message).toMatch(/while a new one is generated/);
  });

  it('carries forward that some checks did not run when it was built',()=>{
    const partial={...ready,complete:false};
    expect(S.briefingView(partial,partial,'2026-09-10').coverageNote).toMatch(/could not run/);
    expect(S.briefingView(ready,ready,'2026-09-10').coverageNote).toBe(null);
  });
});

// The route handlers must use these rules rather than reimplementing them inline, which is
// how the two copies drifted apart in the first place.
describe('The server routes delegate to these rules',()=>{
  const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
  it.each(['validateAlertState','startsReviewed','reviewDecisions','briefingView'])(
    'server.js calls InboxState.%s',fn=>{
      expect(server).toContain(`InboxState.${fn}(`);
    });
});
