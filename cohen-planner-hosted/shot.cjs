const {chromium}=require('playwright');const fs=require('fs');
const chartJs=fs.readFileSync('node_modules/chart.js/dist/chart.umd.js','utf8');
const views=JSON.parse(process.argv[2]);
(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
  const p=await b.newPage({viewport:{width:1512,height:982},deviceScaleFactor:2});
  await p.route('**/*',async r=>{const u=r.request().url();
    if(/chart\.js|chart\.umd|chartjs/i.test(u))return r.fulfill({status:200,contentType:'text/javascript',body:chartJs});
    if(/^https?:\/\/(cdn\.|fonts\.|www\.g)/i.test(u))return r.fulfill({status:200,contentType:'text/javascript',body:'/*stub*/'});
    return r.continue();});
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  await p.goto('http://localhost:4173/',{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(2600);
  for(const [tab,sub,name] of views){
    if(tab)await p.evaluate(([t,s])=>{setTab(t);if(s)setSubView(s)},[tab,sub]);
    await p.waitForTimeout(1500);
    await p.screenshot({path:'/tmp/n-'+name+'.png',fullPage:true});
  }
  console.log('errors:',errs.slice(0,4).join(' | ')||'none');
  await b.close();
})();
