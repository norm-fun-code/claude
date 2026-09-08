'use strict';
// Offline UI QA: repository defaults, in-memory state, no credentials or external APIs.
// Production uses server.js and its normal authentication/database path.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'../public');
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
    if(url.pathname==='/api/monarch-status')return json({connected:false});
    if(url.pathname==='/api/snapshots'||url.pathname==='/api/chats')return json([]);
    return json({error:'Not connected in offline preview'},503);
  }
  if(url.pathname==='/qa/mobile'){
    res.writeHead(200,{'Content-Type':'text/html'});
    return res.end('<!doctype html><html><head><title>Mobile QA · 390px</title></head><body style="margin:0;background:#dbe3ed"><iframe title="390 pixel mobile preview" src="/" style="border:0;width:390px;height:850px"></iframe></body></html>');
  }
  const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(!['index.html','model.js','decisions.js','decision-room.js','decision-room.css'].includes(file)){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html','Cache-Control':'no-store'});
  const content=file==='index.html'?fs.readFileSync(path.join(root,'index.html'),'utf8').replace('<body>','<body><div style="padding:7px 12px;background:#fff1cc;color:#614b10;font:12px system-ui;margin-bottom:10px">Offline preview · sample assumptions · changes stay in memory</div>'):fs.readFileSync(path.join(root,file));
  res.end(content);
});
const portIndex=process.argv.indexOf('--port');
const port=portIndex>=0?Number(process.argv[portIndex+1]):4173;
server.listen(port,'0.0.0.0',()=>console.log('Offline planner preview on port '+port));
