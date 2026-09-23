import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
const SERVER=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
// The model, ceiling and effort live beside the routes in server.js. Reading them from there
// keeps this harness honest: it cannot pass while disagreeing with what actually ships.
const decl=k=>{const m=SERVER.match(new RegExp('const '+k+' *= *([^;]+);'));return m&&eval('('+m[1]+')')};
const advisorSettings=()=>({ADVISOR_MODEL:decl('ADVISOR_MODEL'),ADVISOR_MAX_TOKENS:decl('ADVISOR_MAX_TOKENS'),
  ADVISOR_EFFORT:decl('ADVISOR_EFFORT'),
  advisorRefusal:new vm.Script(SERVER.slice(SERVER.indexOf('function advisorRefusal'),
    SERVER.indexOf('// ── Anthropic proxy'))+';advisorRefusal').runInNewContext({})});

it('emits and saves structured proposals alongside assistant prose',async()=>{
 const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 const source=server.slice(server.indexOf("app.post('/api/advisor/stream'"),server.indexOf("app.post('/api/advisor/agentic'"));
 let handler,round=0;const emitted=[],saved=[],requests=[];
 const signedThinking={type:'thinking',thinking:'',signature:'signed-omitted-reasoning'};
 const proposal={status:'proposed',applied:{homePrice:{from:2000000,to:900000}},baseline:{homePrice:2000000},rationale:'Compare a smaller home'};
 const context={app:{post:(_p,...args)=>handler=args.at(-1)},requireAuth(){},advisorLimiter(){},
   ...advisorSettings(),
   withTimeout:async p=>p,getMonarchAdvisorTools:async()=>[],TaxRules:{staleness:()=>({})},advisorGrounding:()=>'',
   AdvisorTools:{TOOLS:[]},PLANNER_TOOL_NAMES:new Set(['propose_changes']),runPlannerTool:async()=>proposal,
   anthropic:{messages:{stream:req=>{requests.push(req);const first=round++===0;let cb;return{on:(_e,f)=>cb=f,finalMessage:async()=>{
     if(!first)cb('Review the proposed change.');return first?{stop_reason:'tool_use',content:[signedThinking,{type:'tool_use',id:'p1',name:'propose_changes',input:{}}]}:{stop_reason:'end_turn',content:[]};
   }}}}},db:{query:async(sql,params)=>{saved.push({sql,params});return{rows:[{cnt:4}]};}},console,Date};
 vm.createContext(context);vm.runInContext(source,context);
 await handler({body:{chatId:'synthetic',message:'Compare a smaller home',systemPrompt:'',messages:[]}},
 {setHeader(){},flushHeaders(){},write:s=>emitted.push(s),end(){}});
 const events=emitted.filter(s=>s.startsWith('data: ')).map(s=>JSON.parse(s.slice(6)));
 expect(events.find(e=>e.tool_result)?.tool_result.result.applied.homePrice.to).toBe(900000);
 const update=saved.find(x=>x.sql.includes('messages = messages ||'));
 const pair=JSON.parse(update.params[0]);expect(pair[1].structuredResults[0].result).toEqual(proposal);
 expect(pair[1].content).toBe('Review the proposed change.');
 // Sonnet 5's default omitted display intentionally returns an empty thinking string with
 // a signature. The next tool round must echo the entire block exactly as received.
 expect(requests[1].messages.at(-2).content[0]).toEqual(signedThinking);
});

// ── What the request is actually built with ─────────────────────────────────
describe('every call the tool loop makes',()=>{
  it('carries the one model, its ceiling and its effort',async()=>{
    // Three literals in three routes drift, and the only symptom is one of them quietly
    // answering worse than the others.
    const source=SERVER.slice(SERVER.indexOf("app.post('/api/advisor/stream'"),SERVER.indexOf("app.post('/api/advisor/agentic'"));
    let handler,round=0;const requests=[];
    const context={app:{post:(_p,...args)=>handler=args.at(-1)},requireAuth(){},advisorLimiter(){},
      ...advisorSettings(),
      withTimeout:async p=>p,getMonarchAdvisorTools:async()=>[],TaxRules:{staleness:()=>({})},advisorGrounding:()=>'',
      AdvisorTools:{TOOLS:[]},PLANNER_TOOL_NAMES:new Set(['propose_changes']),runPlannerTool:async()=>({ok:true}),
      anthropic:{messages:{stream:req=>{requests.push(req);const first=round++===0;let cb;
        return{on:(_e,f)=>cb=f,finalMessage:async()=>{if(!first)cb('done');
          return first?{stop_reason:'tool_use',content:[{type:'tool_use',id:'t',name:'propose_changes',input:{}}]}
                      :{stop_reason:'end_turn',content:[]};}};}}},
      db:{query:async()=>({rows:[{cnt:4}]})},console,Date};
    vm.createContext(context);vm.runInContext(source,context);
    await handler({body:{chatId:'c',message:'m',systemPrompt:'',messages:[]}},
      {setHeader(){},flushHeaders(){},write(){},end(){}});
    expect(requests.length).toBeGreaterThan(1);
    for(const r of requests){
      expect(r.model).toBe(decl('ADVISOR_MODEL'));
      expect(r.max_tokens).toBe(decl('ADVISOR_MAX_TOKENS'));
      expect(r.output_config).toEqual(decl('ADVISOR_EFFORT'));
    }
  });
});

// ── A refusal is a 200 with nothing usable in it ────────────────────────────
describe('when the request is declined',()=>{
  const fn=advisorSettings().advisorRefusal;

  it('names the refusal, and the category when there is one',()=>{
    expect(fn({stop_reason:'refusal',stop_details:{category:'cyber'}})).toMatch(/declined by a safety filter \(cyber\)/);
  });

  it('says nothing about a category the refusal did not give',()=>{
    const t=fn({stop_reason:'refusal',stop_details:null});
    expect(t).toMatch(/declined by a safety filter, so/);
    expect(t).not.toMatch(/\(\)/);
  });

  it('leaves every other stop reason alone',()=>{
    for(const stop of ['end_turn','tool_use','max_tokens','pause_turn',null,undefined])
      expect(fn({stop_reason:stop})).toBeNull();
    expect(fn(null)).toBeNull();
  });

  it('is wired into all three advisor routes',()=>{
    // The loops knew `tool_use` and `end_turn` only, so a refusal fell straight through and
    // read as the advisor having nothing to say.
    expect(SERVER.match(/advisorRefusal\(/g)).toHaveLength(4);   // definition + three routes
    expect(SERVER.match(/const declined = advisorRefusal\(msg\);/g)).toHaveLength(2);
    expect(SERVER).toContain('const reply = advisorRefusal(response) ||');
  });
});
