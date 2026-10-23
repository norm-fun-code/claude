'use strict';
// Verification only. Reads the same data through Monarch's MCP and lines it up against what the planner
// already holds from its current sync. Nothing here writes to the ledger, the balances or the holdings:
// the MCP is not a source until this comparison comes back clean.

// ── Reading MCP payloads ─────────────────────────────────────────────────
// Tool outputs are JSON whose exact nesting is Monarch's to choose. Find the list that holds the records
// (by preferred key first, then any array of objects that has the fields a record must have), and map
// fields by the names Monarch uses in its API. A record missing a required field is an error, not a guess.
const get=(o,...paths)=>{for(const p of paths){let v=o;for(const k of p.split('.')){v=v==null?undefined:v[k];}if(v!==undefined&&v!==null)return v;}return undefined;};
function findList(payload,keys,looksRight){
  const seen=new Set();
  const walk=(v,depth)=>{
    if(v==null||depth>6||seen.has(v))return null;
    if(Array.isArray(v))return v.length&&v.every(x=>x&&typeof x==='object')&&looksRight(v[0])?v:(v.length===0?v:null);
    if(typeof v!=='object')return null;
    seen.add(v);
    for(const k of keys)if(Array.isArray(v[k]))return v[k];
    for(const k of keys)if(v[k]&&typeof v[k]==='object'){const r=walk(v[k],depth+1);if(r)return r;}
    for(const x of Object.values(v)){const r=walk(x,depth+1);if(Array.isArray(r)&&r.length)return r;}
    return null;
  };
  return walk(payload,0);
}
const num=v=>{if(v==null||v==='')return null;const n=Number(typeof v==='string'?v.replace(/[$,\s]/g,''):v);return Number.isFinite(n)?n:null;};
const str=v=>v==null?null:String(v);

function accountsFrom(payload){
  const list=findList(payload,['accounts','results','items','data'],a=>a.id!=null&&('currentBalance' in a||'balance' in a||'current_balance' in a||'displayBalance' in a));
  if(!list)throw new Error('The MCP account list could not be found in its response.');
  return list.map(a=>{
    if(a.id==null)throw new Error('The MCP returned an account without an id.');
    return {id:String(a.id),name:get(a,'displayName','display_name','name')||'',
      balance:num(get(a,'currentBalance','current_balance','balance','displayBalance')),
      type:get(a,'type.name','type','account_type')||'',subtype:get(a,'subtype.name','subtype')||'',
      institution:get(a,'institution.name','institution','institution_name')||''};
  });
}
function categoriesFrom(payload){
  const list=findList(payload,['categories','results','items','data'],c=>c.id!=null&&'name' in c);
  if(!list)throw new Error('The MCP category list could not be found in its response.');
  return list.map(c=>({id:String(c.id),name:String(c.name||''),
    groupType:String(get(c,'group.type','groupType','group_type','type')||'').toLowerCase()}));
}
function transactionsFrom(payload){
  const list=findList(payload,['transactions','results','items','data'],t=>t.id!=null&&'amount' in t&&'date' in t);
  if(!list)throw new Error('The MCP transaction list could not be found in its response.');
  const total=num(get(payload,'totalCount','total_count','total','allTransactions.totalCount'));
  return {total,rows:list.map(t=>{
    const amount=num(t.amount),date=String(t.date||'').slice(0,10);
    if(t.id==null||amount===null||!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('The MCP returned a transaction without an id, date or amount.');
    return {id:String(t.id),date,amount,categoryId:str(get(t,'category.id','categoryId','category_id')),
      categoryName:get(t,'category.name','categoryName','category_name')||'',accountId:str(get(t,'account.id','accountId','account_id')),
      merchant:get(t,'merchant.name','merchant','merchantName','plaidName')||'',pending:!!t.pending,
      hidden:!!(t.hideFromReports||t.hide_from_reports||t.hiddenByAccount)};
  })};
}
function holdingsFrom(payload){
  const list=findList(payload,['holdings','aggregateHoldings','positions','edges','results','items','data'],h=>h&&(h.node||'totalValue' in h||'value' in h||'quantity' in h));
  if(!list)throw new Error('The MCP holdings list could not be found in its response.');
  return list.map(x=>{const h=x.node||x;
    return {id:str(h.id),ticker:get(h,'security.ticker','ticker','symbol','security.name','name')||'',
      value:num(get(h,'totalValue','total_value','value','marketValue')),quantity:num(get(h,'quantity','shares'))};});
}

// ── Comparing ────────────────────────────────────────────────────────────
const round=v=>Math.round(v*100)/100;
const sample=(a,n=15)=>a.slice(0,n);
function compareAccounts(mine,theirs){
  const byId=new Map(theirs.map(a=>[a.id,a])),out={planner:mine.length,mcp:theirs.length,matched:0,balanceDiffs:[],onlyPlanner:[],onlyMcp:[]};
  for(const a of mine){
    const b=byId.get(a.id);
    if(!b){out.onlyPlanner.push(a.name);continue;}
    byId.delete(a.id);out.matched++;
    if(a.balance==null||b.balance==null){if((a.balance==null)!==(b.balance==null))out.balanceDiffs.push({name:a.name,planner:a.balance,mcp:b.balance});}
    else if(Math.abs(a.balance-b.balance)>=1)out.balanceDiffs.push({name:a.name,planner:round(a.balance),mcp:round(b.balance)});
  }
  out.onlyMcp=[...byId.values()].map(a=>a.name);
  out.ok=!out.balanceDiffs.length&&!out.onlyPlanner.length&&!out.onlyMcp.length;
  return out;
}
function compareCategories(mine,theirs){
  const byId=new Map(theirs.map(c=>[c.id,c])),out={planner:mine.length,mcp:theirs.length,renamed:[],onlyPlanner:[],onlyMcp:[]};
  for(const c of mine){const d=byId.get(c.id);if(!d){out.onlyPlanner.push(c.name);continue;}byId.delete(c.id);if(d.name!==c.name)out.renamed.push({planner:c.name,mcp:d.name});}
  out.onlyMcp=[...byId.values()].map(c=>c.name);
  out.ok=!out.renamed.length&&!out.onlyPlanner.length&&!out.onlyMcp.length;
  return out;
}
// Transactions are compared by id inside one window, and also as month totals, because a total that
// agrees with id-level differences beneath it tells a different story from one that does not.
function compareTransactions(mine,theirs,{startDate,endDate}){
  const inWin=t=>t.date>=startDate&&t.date<=endDate;
  mine=mine.filter(inWin);theirs=theirs.filter(inWin);
  const byId=new Map(theirs.map(t=>[t.id,t]));
  const out={window:{startDate,endDate},planner:mine.length,mcp:theirs.length,matched:0,amountDiffs:[],dateDiffs:[],categoryDiffs:[],onlyPlanner:[],onlyMcp:[],months:[]};
  const brief=t=>({date:t.date,amount:round(t.amount),merchant:t.merchant||'',category:t.categoryName||''});
  for(const t of mine){
    const u=byId.get(t.id);
    if(!u){out.onlyPlanner.push(brief(t));continue;}
    byId.delete(t.id);out.matched++;
    if(Math.abs(t.amount-u.amount)>=0.01)out.amountDiffs.push({...brief(t),mcp:round(u.amount)});
    if(t.date!==u.date)out.dateDiffs.push({...brief(t),mcp:u.date});
    if((t.categoryId||null)!==(u.categoryId||null))out.categoryDiffs.push({...brief(t),mcp:u.categoryName||u.categoryId});
  }
  const onlyMcp=[...byId.values()];
  out.onlyMcp=sample(onlyMcp.map(brief));out.onlyMcpCount=onlyMcp.length;
  out.onlyPlannerCount=out.onlyPlanner.length;out.onlyPlanner=sample(out.onlyPlanner);
  for(const k of ['amountDiffs','dateDiffs','categoryDiffs']){out[k+'Count']=out[k].length;out[k]=sample(out[k]);}
  const months=new Map();
  const add=(t,side)=>{const m=t.date.slice(0,7);if(!months.has(m))months.set(m,{month:m,planner:0,mcp:0});months.get(m)[side]+=t.amount;};
  mine.forEach(t=>add(t,'planner'));theirs.forEach(t=>add(t,'mcp'));
  out.months=[...months.values()].sort((a,b)=>a.month<b.month?-1:1).map(m=>({...m,planner:round(m.planner),mcp:round(m.mcp),diff:round(m.mcp-m.planner)}));
  out.ok=!out.onlyPlannerCount&&!out.onlyMcpCount&&!out.amountDiffsCount&&!out.dateDiffsCount&&!out.categoryDiffsCount;
  return out;
}
function compareHoldings(mine,theirs){
  const total=a=>round(a.reduce((s,h)=>s+(h.value||0),0));
  const t1=total(mine),t2=total(theirs);
  const out={planner:mine.length,mcp:theirs.length,plannerTotal:t1,mcpTotal:t2,diff:round(t2-t1)};
  // Prices move through the day, so values agree to within half a percent rather than to the cent.
  out.ok=mine.length===theirs.length&&Math.abs(t2-t1)<=Math.max(1,Math.abs(t1)*0.005);
  return out;
}
module.exports={findList,accountsFrom,categoriesFrom,transactionsFrom,holdingsFrom,
  compareAccounts,compareCategories,compareTransactions,compareHoldings};
