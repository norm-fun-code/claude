'use strict';
// Offline UI QA: repository defaults, in-memory state, no credentials or external APIs.
// Production uses server.js and its normal authentication/database path.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'../public');
const Model=require('../public/model.js');
const Monitors=require('../public/monitors.js');
const TaxPlan=require('../public/tax-plan.js');
const TaxRules=require('../public/tax-rules.js');
const Liquidity=require('../public/liquidity.js');
const InboxState=require('../public/inbox-state.js');
const Pace=require('../public/pace.js');
const alertStates={};
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const P=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');
let state={P,experienceVersion:6,activeTab:'home'};
const scenarios=[];
let failWrites=false;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const json=(body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
  if(url.pathname==='/qa/fail-writes'){failWrites=url.searchParams.get('enabled')==='1';return json({failWrites});}
  if(url.pathname.startsWith('/api/')){
    let data='';for await(const part of req)data+=part;
    if(failWrites&&req.method!=='GET')return json({error:'QA: simulated save failure'},503);
    if(url.pathname==='/api/planner-state'){
      if(req.method==='PUT')state=JSON.parse(data).state;
      return json({state});
    }
    if(url.pathname==='/api/scenarios'){
      if(req.method==='POST')scenarios.push(JSON.parse(data));
      return json(req.method==='GET'?scenarios:{ok:true});
    }
    if(url.pathname==='/api/monarch/sync/status')return json({transactions:1200,firstDate:'2025-09-01',lastDate:'2026-09-10',lastSyncAt:'2026-09-10T18:00:00Z'});
    if(url.pathname==='/api/monarch/spending'){
      const months=Array.from({length:13},(_,i)=>{
        const month=new Date(Date.UTC(2025,8+i,1)).toISOString().slice(0,7);
        const categories=['Rent','Travel','Shopping','Restaurants','Groceries','Other'].map((name,j)=>({id:String(j),name,net:(j===0?4000:700+j*50)*(i===12?.3:1),gross:(j===0?4000:700+j*50)*(i===12?.3:1),refunds:0,count:10}));
        return{month,categories,expense:categories.reduce((n,c)=>n+c.net,0),income:i===12?3000:13000,transfer:2000,cardPayment:1000,investment:500,count:90};
      });
      // A dated synthetic ledger so the pace card can be exercised offline. Pace needs
      // per-day transactions; the monthly rollup above cannot supply them.
      const rows=[];let seq=0;
      const put=(m,d,amt,cat)=>rows.push({id:'t'+(seq++),date:m+'-'+String(d).padStart(2,'0'),amount:-amt,categoryName:cat});
      for(const m of ['2026-06','2026-07','2026-08']){
        put(m,1,5200,'Rent');put(m,2,900,'Tuition');
        for(let d=1;d<=28;d++){put(m,d,55+(d%5)*12,'Restaurants');put(m,d,40+(d%7)*9,'Groceries');}
        put(m,8,320,'Shopping');put(m,19,260,'Shopping');put(m,14,180,'Entertainment');
      }
      put('2026-09',1,5200,'Rent');put('2026-09',2,900,'Tuition');
      for(let d=1;d<=10;d++){put('2026-09',d,55+(d%5)*12,'Restaurants');put('2026-09',d,40+(d%7)*9,'Groceries');}
      put('2026-09',3,1750,'Travel');put('2026-09',6,980,'Shopping');put('2026-09',9,640,'Shopping');
      const pace=Pace.pace(rows,new Map(),{asOf:'2026-09-10'});
      return json({endDate:'2026-09-10',months,pace,coverage:{first:'2025-09',last:'2026-09',completeMonths:[],partial:'2026-09',fractionElapsed:.33},rolling:{m3:null,m6:null,m12:null},totals:{expense:months.reduce((n,m)=>n+m.expense,0),income:159000},counts:{expense:1000}});
    }
    if(url.pathname==='/api/monarch-status')return json({connected:false});
    if(url.pathname==='/api/snapshots'||url.pathname==='/api/chats')return json([]);
    if(url.pathname==='/api/alerts/states')return json(alertStates);
    if(/^\/api\/alerts\/.+\/state$/.test(url.pathname)){
      const key=decodeURIComponent(url.pathname.split('/')[3]);
      const body=JSON.parse(data||'{}');
      const v=InboxState.validateAlertState({state:body.state,until:body.until});
      if(!v.ok)return json({error:v.error},400);
      if(body.state==='open')delete alertStates[key];
      else alertStates[key]={state:body.state,until:v.until,since:new Date().toISOString()};
      return json({ok:true,state:body.state});
    }
    if(url.pathname==='/api/briefings/latest')return json(InboxState.briefingView(null,null));
    if(url.pathname==='/api/inbox'){
      // Same detection the server runs, over the offline plan. No accounts, no ledger and no
      // tax facts, so several monitors report themselves as unchecked — which is exactly the
      // state this preview is most useful for exercising.
      const today=url.searchParams.get('today')||new Date().toISOString().slice(0,10);
      const R=Model.run(state.P).R;
      const ctx={P:state.P,R,liquidity:Liquidity,taxRules:TaxRules,today,
        marginalRate:R[0]&&R[0].sVestRate,
        sources:{plan:'ok',accounts:'unavailable: offline preview',
          spending:'unavailable: offline preview',taxFacts:'missing withheldToDate',
          decisions:'ok'}};
      const detection=Monitors.detect(ctx);
      const prioritized=Monitors.prioritize(detection.alerts,alertStates,{today,limit:3});
      const opportunities=TaxPlan.screenOpportunities({P:state.P,R,marginalRate:ctx.marginalRate});
      const needs=opportunities.flatMap(o=>o.needs||[]);
      return json({generatedAt:detection.generatedAt,...prioritized,
        notChecked:detection.skipped,checksThatFailed:detection.failed,
        checksRun:detection.checksRun,checksTotal:detection.checksTotal,
        sources:ctx.sources,taxPlan:null,opportunities,
        documentRequests:TaxPlan.documentRequests(needs)});
    }
    return json({error:'Not connected in offline preview'},503);
  }
  if(url.pathname==='/qa/mobile'){
    res.writeHead(200,{'Content-Type':'text/html'});
    return res.end('<!doctype html><html><head><title>Mobile QA · 390px</title></head><body style="margin:0;background:#dbe3ed"><iframe title="390 pixel mobile preview" src="/" style="border:0;width:390px;height:850px"></iframe></body></html>');
  }
  const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
  // Serve whatever actually lives in public/, rather than a hardcoded list that silently
  // goes stale every time a module is added — which is how liquidity.js came to 404 here
  // while the real server had the same gap.
  if(!/^[\w.-]+\.(js|css|html)$/.test(file)||!fs.existsSync(path.join(root,file))){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html','Cache-Control':'no-store'});
  const content=file==='index.html'?fs.readFileSync(path.join(root,'index.html'),'utf8').replace('<body>','<body><div style="padding:7px 12px;background:#fff1cc;color:#614b10;font:12px system-ui;margin-bottom:10px">Offline preview · sample assumptions · changes stay in memory</div>'):fs.readFileSync(path.join(root,file));
  res.end(content);
});
const portIndex=process.argv.indexOf('--port');
const port=portIndex>=0?Number(process.argv[portIndex+1]):4173;
server.listen(port,'0.0.0.0',()=>console.log('Offline planner preview on port '+port));
