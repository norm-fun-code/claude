'use strict';
// Read-only audit probes. Synthetic fixtures; no network, production data, or DB writes.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const M=require('../public/model'),A=require('../public/accounts'),S=require('../public/spending');
const T=require('../public/tax-plan'),Mon=require('../public/monitors'),L=require('../public/liquidity');
const Tools=require('../public/advisor-tools'),Rules=require('../public/tax-rules');
const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const defaults=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
const P={...defaults,planStartYear:2026,planEndYear:2028,homePurchaseYear:2027,
  homePrice:1000000,downPctg:50,mortgageRate:5,startingLiquid:2000000,
  startingStripeEquity:0,k401Start:100000,stripeObservedMonth:null,
  nancyRampYear:2099,nancyW2Y0:0,nancyW2Y1:0,nancyW2Y2:0,nancyW2Y3:0};
for(let y=0;y<=10;y++){P['normCashY'+y]=500000;P['normStockY'+y]=0;}
const findings=[];
function record(id,confirmed,evidence){assert.ok(confirmed,'Probe no longer reproduces: '+id);findings.push({id,evidence});}
(async()=>{
 // Reuse the existing suite's in-memory SQL adapter, run real sync/ledger functions.
 const test=fs.readFileSync(path.join(root,'test/monarch-sync.test.js'),'utf8');
 const fakeDb=vm.runInNewContext('('+test.slice(test.indexOf('function fakeDb()'),test.indexOf('// A fake Monarch'))+')');
 const db=fakeDb();let pages=0;
 const tx=id=>({id,date:'2026-03-05',amount:-100,merchant:'Synthetic store',tags:[]});
 const sync=require('../monarch-sync').createMonarchSync({db,live:{transactionsPage:async()=>
   (++pages===1?{totalCount:2,results:[tx('a')]}:{totalCount:2,results:[]})}});
 await sync.upsert([tx('a'),tx('b')]);
 const result=await sync.backfill({startDate:'2026-03-01',endDate:'2026-03-31'});
 const ledger=await sync.ledger({startDate:'2026-03-01',endDate:'2026-03-31'});
 record('F1-short-page-deletes',result.error===null&&ledger.length===1,
   {before:2,after:ledger.length,reportedError:result.error,completedMonths:result.months});
 // Real projection ignores costs that the separate cash-to-close helper displays.
 const base=M.run(P),costly=M.run({...P,closingLegalFees:(P.closingLegalFees??5000)+250000,homeInsuranceAnnual:25000});
 record('F2-closing-insurance-not-projected',JSON.stringify(base.R)===JSON.stringify(costly.R),
   {extraClosingCost:250000,annualInsuranceOverride:25000,projectionChanged:false});
 const noWindows={...P,startingStripeEquity:500000,stripeTenderQuarters:[],stripeElectiveCashAnnualCap:0,stripeElectiveCashPerQuarter:0};
 const withWindows={...noWindows,stripeTenderQuarters:[1,4]};
 record('F2-liquidity-calendar-not-projected',JSON.stringify(M.run(noWindows).R)===JSON.stringify(M.run(withWindows).R),
   {calendarA:[],calendarB:[1,4],projectionChanged:false});
 // All-cash and 0%-mortgage are permitted UI/tool inputs.
 const allCash=M.run({...P,downPctg:100}).R.find(r=>r.yr===2027);
 const zeroRate=M.run({...P,mortgageRate:0}).R.find(r=>r.yr===2027);
 record('F3-valid-boundaries-NaN',Number.isFinite(allCash.tax)&&!Number.isFinite(zeroRate.tax),
   {allCashTax:String(allCash.tax),zeroRateTax:String(zeroRate.tax),zeroRateAnnualPayment:M.mPmt(500000,0)});
 // SALT is a deduction for eligible tax paid, capped by law, not an unconditional cap credit.
 const taxP={...P,homePurchaseYear:2099,pretax401k:0,pretaxBenefits:0,baseCharity:0,taxInflation:0,
   _normW2:80000,_nancyW2:0,_nancySE:0,_nancyOverhead:0};
 const lowTax=M.calcTax(80000,taxP,2026,0),futureTax=M.calcTax(80000,taxP,2030,0);
 record('F4-SALT-deduction-and-sunset',lowTax.deduction===40400&&futureTax.saltCap===40400,
   {modeledStateAndCity:lowTax.state+lowTax.city,claimedDeduction:lowTax.deduction,
    modeled2030Cap:futureTax.saltCap,statutory2030Cap:10000});
 // Payments have no dates or jurisdictions; totals alone assert freedom from penalties.
 const status=T.withholdingStatus({taxYear:2026,asOf:'2026-12-31',projectedLiability:100000,
   priorYearLiability:50000,priorYearAGI:200000,withheldToDate:0,estimatedPaid:60000});
 record('F5-tax-payment-timing',status.interpretation.includes('no underpayment charge'),
   {paidWithoutAnyTimingEvidence:60000,interpretation:status.interpretation});
 // Live routing, using the actual context assembler with synthetic dependencies.
 const ctxDb={query:async(sql)=>sql.includes('SELECT state FROM planner_state')?{rows:[{state:{P}}]}:{rows:[]}};
 const functionText=server.slice(server.indexOf('async function buildMonitorContext(today)'),server.indexOf("app.get('/api/inbox'"));
 const context={db:ctxDb,migrateP:x=>x,runModel:M.run,Liquidity:L,TaxRules:Rules,TaxPlan:T,Accounts:A,Spending:S,
   loadAccountMeta:async()=>({merged:{}}),monarchLive:{getSnapshot:async()=>({
     accounts:[{id:'cash',displayName:'Checking',currentBalance:100000}],
     partial:true,missingAccounts:[{id:'missing',name:'Synthetic missing account'}],asOf:'2026-09-11T00:00:00Z'})},
   monarchSync:{ledger:async()=>[],localCategories:async()=>[]},require:n=>require(path.join(root,n)),Date};
 vm.createContext(context);vm.runInContext(functionText,context);
 const monitorContext=await context.buildMonitorContext('2026-09-11');
 record('F6-partial-snapshot-lost',monitorContext.accounts.complete===true,
   {upstreamPartial:true,missingAccounts:1,monitorComplete:monitorContext.accounts.complete});
 const dif=Mon.divergence({P:{divergenceThresholdPct:.15,divergenceThresholdAbs:50000},
   R:[{yr:2026,nw:100000,k401:250000,totE:120000}],accounts:{complete:true,netWorth:350000}});
 record('F6-retirement-false-divergence',dif.alerts.some(a=>a.key.includes('netWorth')),
   {sameWealth:true,planExRetirement:100000,planRetirement:250000,observedInclusive:350000,
    alert:dif.alerts.find(a=>a.key.includes('netWorth')).title});
 // A few transactions in discontinuous months are claimed as complete coverage.
 const months=S.summarize(['2026-01-31','2026-03-31','2026-06-30'].map((date,i)=>({id:String(i),date,amount:-100})),[]).months;
 const coverage=S.coverage(months,'2026-09-11');
 record('F7-false-history-coverage',coverage.completeMonths.length===3,
   {oneTransactionPerMonth:coverage.completeMonths,claimedThreeMonthAverage:S.rollingAverage(months,3,null,'2026-09-11')});
 // Run the actual streaming route with a deterministic tool-using model double.
 let handler,round=0;const emitted=[],saved=[];
 const routeText=server.slice(server.indexOf("app.post('/api/advisor/stream'"),server.indexOf("app.post('/api/advisor/agentic'"));
 const routeCtx={app:{post:(_p,...args)=>handler=args.at(-1)},requireAuth:()=>{},advisorLimiter:()=>{},
   withTimeout:async(p)=>p,getMonarchAdvisorTools:async()=>[],TaxRules:Rules,advisorGrounding:()=>'',
   AdvisorTools:Tools,PLANNER_TOOL_NAMES:new Set(Tools.TOOLS.map(x=>x.name)),
   runPlannerTool:async(name,input)=>Tools.proposeChanges({P,...input}),
   anthropic:{messages:{stream:()=>{const first=round++===0;let cb;return{
     on:(_e,f)=>cb=f,finalMessage:async()=>{if(!first)cb('Review the proposed change.');return first?
       {stop_reason:'tool_use',content:[{type:'tool_use',id:'t',name:'propose_changes',input:{overrides:{homePrice:900000},rationale:'Synthetic test'}}]}:
       {stop_reason:'end_turn',content:[]};}}}}},
   db:{query:async(sql,params)=>{saved.push({sql,params});return{rows:[{cnt:4}]}}},console,Date};
 vm.createContext(routeCtx);vm.runInContext(routeText,routeCtx);
 await handler({body:{chatId:'synthetic',message:'Compare a smaller home',systemPrompt:'',messages:[]}},
   {setHeader(){},flushHeaders(){},write:s=>emitted.push(s),end(){}});
 const events=emitted.filter(s=>s.startsWith('data: ')).map(s=>JSON.parse(s.slice(6)));
 record('F8-proposal-not-delivered',events.some(e=>e.tool_call?.name==='propose_changes')&&
   !JSON.stringify(events).includes('900000')&&!JSON.stringify(saved).includes('900000'),
   {toolRan:true,proposalDataInSSE:false,proposalSaved:false});
 // Reconciliation copies gross accessible assets to a model with no imported debt schedule.
 const sum=A.summarize([{id:'c',name:'Checking',balance:100000},{id:'d',name:'Credit card',balance:-25000}],{});
 const rec=A.reconcile(sum,{startingLiquid:0,startingStripeEquity:0,k401Start:0});
 record('F9-debt-omitted-from-reconciliation',sum.netWorth===75000&&rec.lines[0].actual===100000,
   {observedNetWorth:sum.netWorth,proposedStartingLiquid:rec.lines[0].actual,debt:sum.debt});
 // Empty retirement is silently replaced with a positive balance.
 const retirement=M.run({...P,k401Start:0,pretax401k:0,company401kMatch:0,investReturn:0}).R[0].k401;
 record('F3-zero-retirement-default',retirement===210000,{enteredRetirement:0,modeledRetirement:retirement});
 console.log(JSON.stringify({auditedCommit:'afbbaa19a1fedabb0f2637b4fff0187bfe425006',reproduced:findings.length,findings},null,2));
})().catch(err=>{console.error(err);process.exitCode=1});
