import {it,expect} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
it('emits and saves structured proposals alongside assistant prose',async()=>{
 const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 const source=server.slice(server.indexOf("app.post('/api/advisor/stream'"),server.indexOf("app.post('/api/advisor/agentic'"));
 let handler,round=0;const emitted=[],saved=[];
 const proposal={status:'proposed',applied:{homePrice:{from:2000000,to:900000}},baseline:{homePrice:2000000},rationale:'Compare a smaller home'};
 const context={app:{post:(_p,...args)=>handler=args.at(-1)},requireAuth(){},advisorLimiter(){},
   withTimeout:async p=>p,getMonarchAdvisorTools:async()=>[],TaxRules:{staleness:()=>({})},advisorGrounding:()=>'',
   AdvisorTools:{TOOLS:[]},PLANNER_TOOL_NAMES:new Set(['propose_changes']),runPlannerTool:async()=>proposal,
   anthropic:{messages:{stream:()=>{const first=round++===0;let cb;return{on:(_e,f)=>cb=f,finalMessage:async()=>{
     if(!first)cb('Review the proposed change.');return first?{stop_reason:'tool_use',content:[{type:'tool_use',id:'p1',name:'propose_changes',input:{}}]}:{stop_reason:'end_turn',content:[]};
   }}}}},db:{query:async(sql,params)=>{saved.push({sql,params});return{rows:[{cnt:4}]};}},console,Date};
 vm.createContext(context);vm.runInContext(source,context);
 await handler({body:{chatId:'synthetic',message:'Compare a smaller home',systemPrompt:'',messages:[]}},
 {setHeader(){},flushHeaders(){},write:s=>emitted.push(s),end(){}});
 const events=emitted.filter(s=>s.startsWith('data: ')).map(s=>JSON.parse(s.slice(6)));
 expect(events.find(e=>e.tool_result)?.tool_result.result.applied.homePrice.to).toBe(900000);
 const update=saved.find(x=>x.sql.includes('messages = messages ||'));
 const pair=JSON.parse(update.params[0]);expect(pair[1].structuredResults[0].result).toEqual(proposal);
 expect(pair[1].content).toBe('Review the proposed change.');
});
