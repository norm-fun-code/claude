'use strict';
// Direct, read-only Monarch transport for the transaction ledger. Account/holding bridges
// are independent. Never fall back to NormOS: a failed direct read must preserve local data.
const ENDPOINT = 'https://api.monarch.com/graphql';
const PAGE_SIZE = 100;
const TRANSACTIONS = `query Web_GetTransactionsList($offset: Int, $limit: Int, $filters: TransactionFilterInput, $orderBy: TransactionOrdering) {
  allTransactions(filters: $filters) {
    totalCount
    results(offset: $offset, limit: $limit, orderBy: $orderBy) {
      id date amount pending hideFromReports hiddenByAccount plaidName notes isRecurring isSplitTransaction
      merchant { name } category { id name } account { id displayName } tags { id name }
    }
  }
}`;
const CATEGORIES = `query GetCategories {
  categories { id name systemCategory isDisabled group { id name type } }
}`;
function createMonarchTransactions({env=process.env,fetchImpl=fetch}={}) {
  function headers() {
    const h={'Content-Type':'application/json','Client-Platform':'web'};
    // Cookie authentication takes precedence when the current Monarch session uses it.
    // Credentials remain server-side and are sent only to the fixed Monarch HTTPS origin.
    if(env.MONARCH_COOKIE) {
      const cookie=env.MONARCH_COOKIE.trim();
      h.Cookie=cookie;
      const csrf=cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1];
      if(csrf)h['X-CSRFToken']=csrf;
      h.Origin='https://app.monarch.com';h.Referer='https://app.monarch.com/';
    } else if(env.MONARCH_TOKEN) h.Authorization='Token '+env.MONARCH_TOKEN.trim();
    else throw new Error('Direct Monarch import is not configured. Set MONARCH_TOKEN or MONARCH_COOKIE on the planner service.');
    return h;
  }
  async function query(operationName,query,variables={}) {
    const auth=headers();let response;
    try {
      response=await fetchImpl(ENDPOINT,{method:'POST',headers:auth,body:JSON.stringify({operationName,query,variables}),
        cache:'no-store',redirect:'error',signal:AbortSignal.timeout(60000)});
    } catch(e) {
      throw new Error(e?.name==='TimeoutError'?'Monarch timed out returning transaction data.':'Monarch could not be reached. Previously imported transactions were kept.');
    }
    if(response.status===401)throw new Error('Monarch rejected the saved session. Renew the planner’s Monarch connection before importing again.');
    if(response.status===403)throw new Error('Monarch denied the transaction request. Check the planner’s Monarch connection; saved transactions were kept.');
    if(response.status===429)throw new Error('Monarch is rate-limiting imports. Wait before trying again.');
    if(!response.ok)throw new Error('Monarch transaction request failed (HTTP '+response.status+').');
    const body=await response.json().catch(()=>null);
    // Partial GraphQL success is not a complete page: reconciliation must not delete rows
    // because one field or page failed. Do not echo upstream messages that may contain secrets.
    if(!body||body.errors?.length||!body.data)throw new Error('Monarch returned incomplete transaction data. The import stopped without deleting saved history.');
    return body.data;
  }
  async function transactionsPage({startDate,endDate,offset=0,limit=PAGE_SIZE}) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(startDate||'')||!/^\d{4}-\d{2}-\d{2}$/.test(endDate||'')||startDate>endDate
      ||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('Invalid Monarch transaction import window or page.');
    const data=await query('Web_GetTransactionsList',TRANSACTIONS,{offset,limit,orderBy:'date',filters:{startDate,endDate,search:'',categories:[],accounts:[],tags:[]}});
    const page=data.allTransactions;
    if(!page||!Number.isInteger(page.totalCount)||page.totalCount<0||!Array.isArray(page.results)
      ||page.results.some(t=>!t||t.id==null||!/^\d{4}-\d{2}-\d{2}$/.test(t.date||'')||!Number.isFinite(Number(t.amount))||t.amount==null))
      throw new Error('Monarch returned an invalid transaction page. Saved history was kept.');
    return {totalCount:page.totalCount,results:page.results.map(t=>({id:String(t.id),date:t.date,amount:Number(t.amount),
      merchant:t.merchant?.name||t.plaidName||'',plaidName:t.plaidName||'',notes:t.notes||'',
      categoryId:t.category?.id==null?null:String(t.category.id),categoryName:t.category?.name||'',
      accountId:t.account?.id==null?null:String(t.account.id),accountName:t.account?.displayName||'',
      pending:!!t.pending,hideFromReports:!!(t.hideFromReports||t.hiddenByAccount),isRecurring:!!t.isRecurring,
      isSplitTransaction:!!t.isSplitTransaction,tags:Array.isArray(t.tags)?t.tags:[],updatedAt:null}))};
  }
  async function categories() {
    const data=await query('GetCategories',CATEGORIES);
    if(!Array.isArray(data.categories)||!data.categories.length||data.categories.some(c=>!c||c.id==null||typeof c.name!=='string'))
      throw new Error('Monarch returned no usable categories.');
    return data.categories;
  }
  return {transactionsPage,categories,PAGE_SIZE,source:'monarch-direct'};
}
module.exports={createMonarchTransactions,PAGE_SIZE};
