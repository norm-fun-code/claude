'use strict';
const ENDPOINT='https://api.monarch.com/graphql';
function createMonarchClient({db,env=process.env,fetchImpl=fetch}={}) {
  const session=require('./monarch-session').createMonarchSession({db,env,fetchImpl});
  async function query(operationName,query,variables={}) {
    let auth=await session.current();let response;
    try {
      const send=()=>fetchImpl(ENDPOINT,{method:'POST',headers:auth.headers,body:JSON.stringify({operationName,query,variables}),
        cache:'no-store',redirect:'error',signal:AbortSignal.timeout(60000)});
      response=await send();
      if(response.status===401) {
        await session.renew(auth.generation);auth=await session.current();response=await send();
      }
    } catch(e) {
      if(e?.message?.startsWith('Monarch '))throw e;
      throw new Error(e?.name==='TimeoutError'?'Monarch timed out returning financial data.':'Monarch could not be reached. Previously imported transactions were kept.');
    }
    if(response.status===401)throw new Error('Monarch rejected the renewed session. Account verification may be needed; saved transactions were kept.');
    if(response.status===403)throw new Error('Monarch denied the financial request. Check the planner’s Monarch connection; saved transactions were kept.');
    if(response.status===429)throw new Error('Monarch is rate-limiting imports. Wait before trying again.');
    if(!response.ok)throw new Error('Monarch financial request failed (HTTP '+response.status+').');
    const body=await response.json().catch(()=>null);
    // Partial GraphQL success is not a complete page: reconciliation must not delete rows
    // because one field or page failed. Do not echo upstream messages that may contain secrets.
    if(!body||body.errors?.length||!body.data)throw new Error('Monarch returned incomplete financial data. The import stopped without deleting saved history.');
    return body.data;
  }
  return {query,verifySession:session.verify};
}
module.exports={createMonarchClient};
