'use strict';
const {parseBalance}=require('./monarch-accounts');
const QUERY=`query GetAccounts { accounts {
  id displayName currentBalance displayLastUpdatedAt isAsset includeInNetWorth hideFromList
  type { name } subtype { name } institution { name }
} }`;
async function readBalances(client,now=Date.now) {
  const data=await client.query('GetAccounts',QUERY);
  if(!Array.isArray(data.accounts)||!data.accounts.length||data.accounts.some(a=>!a||a.id==null||typeof a.displayName!=='string'))
    throw new Error('Monarch returned incomplete account data. Saved balances were kept.');
  const accounts=[],missingAccounts=[];
  for(const raw of data.accounts) {
    const account={id:String(raw.id),displayName:raw.displayName,institution:raw.institution?.name||'',
      category:raw.type?.name||'',subtype:raw.subtype?.name||'',bankUpdatedAt:raw.displayLastUpdatedAt||null,
      isAsset:raw.isAsset,includeInNetWorth:raw.includeInNetWorth,hideFromList:raw.hideFromList};
    const balance=parseBalance(raw.currentBalance);
    if(balance===null)missingAccounts.push(account);
    else accounts.push({...account,currentBalance:balance});
  }
  if(!accounts.length)throw new Error('Monarch returned no readable balances. Saved balances were kept.');
  return {version:1,source:'monarch-direct',asOf:new Date(now()).toISOString(),accounts,missingAccounts,partial:missingAccounts.length>0};
}
module.exports={readBalances,QUERY};
