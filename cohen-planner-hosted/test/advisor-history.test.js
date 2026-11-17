import {it,expect,vi} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
function harness(overrides={}){
  const notices=[],chat={id:'a',title:'Existing',messages:[]};
  const c={advisorChats:{a:chat},advisorActiveChatId:'a',advisorConversation:chat.messages,
    advisorSwitchVersion:0,advisorSending:new Set(),activeTab:'advisor',_demoMode:false,PlannerTime:{day:()=>'2026-11-17'},
    fetch:async()=>({ok:false,status:503}),showToast:t=>notices.push(t),advUuid:()=>'new',
    advRenderRail(){},advRenderMessages(){},advToggleRail(){},advMarkdown:s=>s,advEscape:s=>s,
    document:{getElementById:()=>null},prompt:()=>'Renamed',confirm:()=>true,Date,Blob,URL,TextDecoder,...overrides};
  vm.createContext(c);
  for(const [a,b] of [['async function chatRequest','function advRenderRail'],['async function advRenameChat','function advImportChats'],['async function advExportChats','async function advSend()'],['async function advSendStream','function advRestoreStructured']])
    vm.runInContext(html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a))),c);
  c._advHideRailMobile=()=>{};
  return {c,chat,notices};
}
it('keeps the existing conversation when create, rename or delete is rejected',async()=>{
  const {c,chat,notices}=harness();expect(await c.advNewChat()).toBe(false);
  await c.advRenameChat('a');await c.advDeleteChat('a');
  expect(c.advisorActiveChatId).toBe('a');expect(c.advisorChats).toEqual({a:chat});
  expect(chat.title).toBe('Existing');expect(notices).toHaveLength(3);
});
it('loads unopened histories for export and never downloads a partial archive',async()=>{
  let fail=false,file;
  const click=vi.fn(),{c}=harness({URL:{createObjectURL:b=>{file=b;return 'blob:test';}},
    document:{createElement:()=>({click})},fetch:async url=>({ok:!fail||url!='/api/chats/b',status:503,
    json:async()=>url==='/api/chats'?[{id:'a'},{id:'b'}]:{id:url.at(-1),messages:[{role:'user',content:'kept'}]}})});
  await c.advExportChats();expect(JSON.parse(await file.text()).chats.b.messages[0].content).toBe('kept');
  fail=true;await c.advExportChats();expect(click).toHaveBeenCalledTimes(1);
});
it('finishes a stream in the originating chat after switching chats or tabs',async()=>{
  const {c,chat}=harness({activeTab:'projection',fetch:async()=>new Response('data: {"delta":"Reply"}\n\ndata: {"done":true}\n\n')});
  chat.messages.push({role:'user',content:'Question'});c.advisorSending.add(chat.id);
  c.advisorActiveChatId='b';c.advisorConversation=[{role:'user',content:'Different question'}];
  await c.advSendStream('Question',chat,'',{innerHTML:'',isConnected:false});
  expect(chat.messages.map(m=>m.content)).toEqual(['Question','Reply']);
  expect(c.advisorConversation).toHaveLength(1);expect(c.advisorSending.size).toBe(0);
});
