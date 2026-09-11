'use strict';
const Accounts=require('./public/accounts');
const MA=require('./monarch-accounts');
// One adapter for overview, persisted snapshots and monitoring. Missing never means zero.
module.exports=function normalizeSnapshot(snap,meta={},today=Date.now()){
  const asOf=snap.asOf||snap.syncedAt||null;
  const accounts=(snap.accounts||[]).map(a=>({id:a.id==null?null:String(a.id),
    name:a.displayName||a.name||'',institution:a.institution||'',category:a.category||'',subtype:a.subtype||'',
    balance:MA.parseBalance(MA.rawBalanceOf(a)),rawBalance:MA.rawBalanceOf(a),asOf}));
  const ids=new Set(accounts.map(a=>a.id));
  for(const raw of snap.missingAccounts||[]){
    const a=typeof raw==='object'&&raw?raw:{name:String(raw)};
    const id=a.id==null?null:String(a.id);
    if(id&&ids.has(id))continue;
    accounts.push({id,name:a.displayName||a.name||'Missing account',balance:null,rawBalance:null,asOf});
  }
  const summary=Accounts.summarize(accounts,meta);
  const unknownPartial=snap.partial===true&&!(snap.missingAccounts||[]).length;
  const partial=unknownPartial||!summary.complete;
  const stamp=Date.parse(asOf);
  const stale=!Number.isFinite(stamp)||Number(today)-stamp>7*86400000;
  return{accounts,asOf,partial,stale,summary:{...summary,complete:accounts.length>0&&!partial}};
};
