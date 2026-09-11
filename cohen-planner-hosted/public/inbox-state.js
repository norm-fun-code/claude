'use strict';
// ═══ INBOX STATE RULES ═══
// Pure, shared by the browser, the server routes and the tests.
//
// These four rules kept wanting to live inside route handlers, where they cannot be tested
// and quietly drift apart from each other. Each one exists to stop a specific way of
// misleading the reader:
//
//   • A snooze without an expiry is a dismissal wearing a friendlier word.
//   • A value read out of a document is not a value the user confirmed.
//   • Silence is not consent: an undecided field stays undecided.
//   • A briefing that failed must not leave the previous one looking current.

(function(root){

  const ALERT_STATES=['open','dismissed','snoozed','resolved'];

  // ── 1. Alert state transitions ───────────────────────────────────────────
  function validateAlertState({state,until,now}){
    if(!ALERT_STATES.includes(state))
      return{ok:false,error:`Unknown state "${state}". One of: ${ALERT_STATES.join(', ')}.`};
    if(state!=='snoozed')return{ok:true,state,until:null};
    // The whole difference between a snooze and a dismissal is that a snooze comes back.
    if(!until)return{ok:false,error:'A snooze needs an until date. Without one it is a dismissal, so say that instead.'};
    const t=Date.parse(until);
    if(Number.isNaN(t))return{ok:false,error:'Snooze until is not a date.'};
    const n=now?Date.parse(now):Date.now();
    if(t<=n)return{ok:false,error:'Snooze until must be in the future, otherwise the alert reappears immediately.'};
    return{ok:true,state,until:new Date(t).toISOString()};
  }

  // ── 2. Where a figure came from decides whether it needs review ──────────
  // Only a number the user typed can arrive already confirmed. Anything extracted from a
  // document starts unreviewed no matter how confident the extractor was, and no matter
  // what the caller asked for.
  const ENTERED='entered';
  function startsReviewed(sourceKind,requested){
    if(sourceKind!==ENTERED)return false;
    return requested!==false;
  }

  // ── 3. Reviewing staged values ───────────────────────────────────────────
  // Returns the three buckets explicitly. `complete` is only true once every staged field
  // has been decided one way or the other.
  function reviewDecisions(fields,decisions){
    const d=decisions||{};
    const accept=[],reject=[],pending=[];
    for(const f of fields||[]){
      const name=typeof f==='string'?f:f.field;
      const choice=d[name];
      if(choice&&choice.accepted===true){
        accept.push({field:name,
          // A correction the reviewer typed beats the extracted value. `undefined` and
          // `null` both mean "no correction", so the extracted value stands.
          value:choice.corrected==null?(typeof f==='string'?undefined:f.value):choice.corrected,
          corrected:choice.corrected!=null});
      } else if(choice&&choice.accepted===false){
        reject.push(name);
      } else {
        pending.push(name);
      }
    }
    return{accept,reject,pending,complete:pending.length===0,
      status:pending.length?'awaitingReview':'reviewed'};
  }

  // ── 4. What the briefing panel is allowed to show ────────────────────────
  // Two facts, never merged: the last briefing that actually finished, and what happened on
  // the most recent attempt. Showing only the first presents stale content as current after
  // a failure; showing only the second blanks the panel the moment anything goes wrong.
  function briefingView(latestReady,mostRecent,now){
    const ready=latestReady&&latestReady.status==='ready'?latestReady:null;
    const failing=!!(mostRecent&&mostRecent.status==='failed');
    const running=!!(mostRecent&&mostRecent.status==='pending');
    // Counted in CALENDAR days, not 24-hour blocks. A briefing written at 6am on the 8th is
    // two days old on the 10th; measuring elapsed hours would floor that to one and
    // understate the staleness by a day, which is the direction that misleads.
    const dayOf=t=>Date.parse(String(t).slice(0,10)+'T00:00:00.000Z');
    const ageDays=ready&&ready.generatedAt
      ?Math.round((dayOf(now||new Date().toISOString())-dayOf(ready.generatedAt))/86400000)
      :null;
    return{
      briefing:ready,
      hasBriefing:!!ready,
      failing,running,
      ageDays,
      // The one-line status a person reads. It must never say "as of today" over yesterday's
      // content, and must never go silent about a failure.
      status:!ready&&failing?'failed-no-prior'
        :!ready&&running?'first-run'
        :!ready?'none'
        :failing?'stale-after-failure'
        :running?'refreshing'
        :'current',
      message:!ready&&failing
        ?`The briefing could not be generated${mostRecent.error?`: ${mostRecent.error}`:'.'} There is no earlier one to fall back on.`
        :!ready&&running?'Generating the first briefing.'
        :!ready?'No briefing has been generated yet.'
        :failing
          ?`Showing the briefing from ${ready.generatedAt.slice(0,10)}. The most recent attempt failed${mostRecent.error?`: ${mostRecent.error}`:'.'} — this is not current.`
          :running?`Showing the briefing from ${ready.generatedAt.slice(0,10)} while a new one is generated.`
          :ageDays>0
            ?`Briefing from ${ready.generatedAt.slice(0,10)}, ${ageDays} day${ageDays===1?'':'s'} old.`
            :'Briefing generated today.',
      // A briefing built while monitors were skipped is worth less than one built over a
      // full picture, and the difference has to survive into the UI.
      coverageNote:ready&&ready.complete===false
        ?'Some checks could not run when this was generated — see what was not checked.'
        :null,
    };
  }

  const api={ALERT_STATES,ENTERED,validateAlertState,startsReviewed,reviewDecisions,briefingView};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.PlannerInboxState=api;
})(typeof window!=='undefined'?window:this);
