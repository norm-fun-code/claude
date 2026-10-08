import {describe,it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createMonarchTransactions}=require('../monarch-transactions');
const transaction={id:'m1',date:'2026-10-06',amount:-42,pending:true,hideFromReports:false,hiddenByAccount:true,isRecurring:false,isSplitTransaction:true,merchant:{name:'Grocery'},category:{id:'c1',name:'Groceries'},account:{id:'a1',displayName:'Card'},tags:[{id:'t1',name:'Family'}]};
const response=data=>({ok:true,status:200,json:async()=>({data})});
const window={startDate:'2026-10-01',endDate:'2026-10-08',offset:100,limit:50};
describe('direct Monarch transaction imports',()=>{
 it('uses only the Monarch origin, sends the window and page, and normalizes rows for the existing ledger',async()=>{
  const fetchImpl=vi.fn(async()=>response({allTransactions:{totalCount:151,results:[transaction]}}));
  const api=createMonarchTransactions({env:{MONARCH_TOKEN:' token ',NORMOS_URL:'https://normos.example',PLANNER_BRIDGE_TOKEN:'bridge'},fetchImpl});
  const page=await api.transactionsPage(window);
  const [url,opts]=fetchImpl.mock.calls[0];
  expect(url).toBe('https://api.monarch.com/graphql');expect(opts.headers.Authorization).toBe('Token token');
  expect(opts.redirect).toBe('error');expect(opts.cache).toBe('no-store');
  expect(JSON.parse(opts.body).variables).toMatchObject({offset:100,limit:50,filters:{startDate:window.startDate,endDate:window.endDate}});
  expect(page).toEqual({totalCount:151,results:[expect.objectContaining({id:'m1',amount:-42,merchant:'Grocery',categoryId:'c1',accountName:'Card',pending:true,hideFromReports:true,isSplitTransaction:true})]});
  expect(JSON.stringify(page)).not.toContain('token');
 });
 it('uses cookie and CSRF authentication when supplied, without also sending the old token',async()=>{
  const fetchImpl=vi.fn(async()=>response({categories:[{id:'c1',name:'Groceries',group:{id:'g1',name:'Food',type:'expense'}}]}));
  const api=createMonarchTransactions({env:{MONARCH_TOKEN:'old',MONARCH_COOKIE:'sessionid=secret; csrftoken=csrf'},fetchImpl});
  expect(await api.categories()).toHaveLength(1);
  expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({Cookie:'sessionid=secret; csrftoken=csrf','X-CSRFToken':'csrf',Origin:'https://app.monarch.com'});
  expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
 });
 it('does not fall back to NormOS or echo secrets on authentication, GraphQL, or malformed-page failures',async()=>{
  for(const res of [
    {ok:false,status:401,json:async()=>({error:'token-secret'})},
    {ok:false,status:429,json:async()=>({})},
    {ok:true,status:200,json:async()=>({data:{allTransactions:{totalCount:0,results:[]}},errors:[{message:'token-secret'}]})},
    response({allTransactions:{totalCount:1,results:[{...transaction,amount:null}]}})
  ]){
    const fetchImpl=vi.fn(async()=>res);const api=createMonarchTransactions({env:{MONARCH_TOKEN:'token-secret',NORMOS_URL:'https://normos.example'},fetchImpl});
    let error;try{await api.transactionsPage(window)}catch(e){error=e}
    expect(error).toBeDefined();expect(error.message).not.toContain('token-secret');expect(fetchImpl).toHaveBeenCalledTimes(1);
  }
 });
 it('rejects missing credentials and invalid windows before a network request',async()=>{
  const fetchImpl=vi.fn();
  await expect(createMonarchTransactions({env:{NORMOS_URL:'https://normos.example'},fetchImpl}).transactionsPage(window)).rejects.toThrow('not configured');
  await expect(createMonarchTransactions({env:{MONARCH_TOKEN:'t'},fetchImpl}).transactionsPage({...window,offset:-1})).rejects.toThrow('Invalid');
  expect(fetchImpl).not.toHaveBeenCalled();
 });
});
