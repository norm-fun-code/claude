'use strict';
// Reject incomplete upstream responses instead of converting missing balances to $0.
function readBalance(acct){
  const raw=acct?.currentBalance??acct?.balance??acct?.current_balance??acct?.displayBalance;
  const cleaned=typeof raw==='string'?raw.trim().replace(/[$,\s]/g,''):raw;
  const value=typeof cleaned==='number'?cleaned:typeof cleaned==='string'&&/^-?\d+(\.\d+)?$/.test(cleaned)?Number(cleaned):NaN;
  if(!Number.isFinite(value))throw new Error('Monarch returned an account without a readable balance. Last good snapshot retained.');
  return value;
}
function extractAccounts(response){
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
      data.forEach(readBalance);
      return data;
    }
    if(data&&typeof data==='object'){
      if(data.error||data.isError)break;
      data=data.accounts??data.result??data.data;
    }else break;
  }
  throw new Error('Monarch returned an unrecognized account response. Last good snapshot retained.');
}
module.exports={extractAccounts,readBalance};
