import {describe,it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createHoldingsBridge}=require('../holdings-bridge');
function setup(body,status=200,disabled=false){const fetchImpl=vi.fn(async()=>({ok:status===200,status,json:async()=>body}));return {fetchImpl,read:createHoldingsBridge({db:{query:async()=>({rows:[{data:{disabled}}]})},env:{NORMOS_URL:'https://normos.example',PLANNER_BRIDGE_TOKEN:'bridge-only'},fetchImpl})};}
describe('holdings through NormOS',()=>{
 it('uses only the fixed bridge endpoint and preserves data warnings',async()=>{const payload={asOf:'2026-09-16',holdings:[{ticker:'ABC',value:100}],stale:true,warning:'Rate limit'};const x=setup(payload);expect(await x.read('YTD')).toEqual(payload);expect(x.fetchImpl.mock.calls[0][0]).toBe('https://normos.example/integrations/planner/holdings?period=YTD');expect(x.fetchImpl.mock.calls[0][1].redirect).toBe('error');});
 it('does not fetch when paused or given an invalid period',async()=>{const x=setup({},200,true);await expect(x.read()).rejects.toThrow(/paused/);expect(x.fetchImpl).not.toHaveBeenCalled();const y=setup({});await expect(y.read('../accounts')).rejects.toThrow(/period/);expect(y.fetchImpl).not.toHaveBeenCalled();});
 it('rejects unavailable or malformed data instead of fabricating an empty portfolio',async()=>{await expect(setup({error:'No holdings yet'},503).read()).rejects.toThrow('No holdings yet');await expect(setup({holdings:[]}).read()).rejects.toThrow('incomplete');});
});
