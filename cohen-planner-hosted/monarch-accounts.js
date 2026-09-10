'use strict';
// Reject incomplete upstream responses instead of converting missing balances to $0.
//
// The one exception is a per-account, dated confirmation from the user. Nothing else may
// turn a missing balance into a number: not a default, not a heuristic, and never a blanket
// rule across accounts. An account the user has confirmed is empty stops poisoning the whole
// snapshot; every OTHER account with a missing balance still rejects it, because a total
// that is quietly short by an unknown amount is worse than no total.
function parseBalance(raw){
  const cleaned=typeof raw==='string'?raw.trim().replace(/[$,\s]/g,''):raw;
  const value=typeof cleaned==='number'?cleaned:typeof cleaned==='string'&&/^-?\d+(\.\d+)?$/.test(cleaned)?Number(cleaned):NaN;
  return Number.isFinite(value)?value:null;
}
function rawBalanceOf(acct){
  return acct?.currentBalance??acct?.balance??acct?.current_balance??acct?.displayBalance;
}
function readBalance(acct,overrides){
  const raw=rawBalanceOf(acct);
  const value=parseBalance(raw);
  if(value!==null)return value;
  // Missing. Only a confirmation naming THIS account's stable id may supply a value.
  const id=acct?.id!=null?String(acct.id):null;
  const ov=id&&overrides?overrides[id]:null;
  if(ov&&ov.balance!=null&&Number.isFinite(Number(ov.balance)))return Number(ov.balance);
  throw new Error('Monarch returned an account without a readable balance. Last good snapshot retained.');
}
function extractAccounts(response,overrides){
  const result=response?.result??response;
  if(response?.error||result?.isError)throw new Error('Monarch could not return account balances.');
  let data=result?.structuredContent??result;
  if(Array.isArray(result?.content)&&!result.structuredContent){
    const block=result.content.find(b=>b.type==='text');
    data=block?.text;
  }
  for(let depth=0;depth<8;depth++){
    if(typeof data==='string'){
      try{data=JSON.parse(data);continue;}catch{break;}
    }
    if(Array.isArray(data)){
      if(!data.length)throw new Error('Monarch returned no accounts. Last good snapshot retained.');
      data.forEach(a=>readBalance(a,overrides));
      return data;
    }
    if(data&&typeof data==='object'){
      if(data.error||data.isError)break;
      data=data.accounts??data.result??data.data;
    }else break;
  }
  throw new Error('Monarch returned an unrecognized account response. Last good snapshot retained.');
}
module.exports={extractAccounts,readBalance,parseBalance,rawBalanceOf};
