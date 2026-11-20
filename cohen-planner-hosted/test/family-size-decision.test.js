import {expect,it} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import Model from '../public/model.js';

const read=file=>fs.readFileSync(new URL('../public/'+file,import.meta.url),'utf8');
const html=read('index.html'),experience=read('experience.js');
const defaults=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');

it('previews another family size without modifying the plan or replacing manual budget pins',()=>{
  const p={...defaults,numKids:3,nycFamilyBudget:true};
  const year=p.kid4Birth;
  p[Model.livingCategoryKey('groceries',year-p.planStartYear)]=16600;
  const before=JSON.stringify(p),base=Model.run(p).R,alt=Model.run({...p,numKids:4}).R;
  const chart={},target={focus(){}};
  const ctx=vm.createContext({
    P:p,run:Model.run,destroyCharts(){},experienceHeader:(_k,title)=>title,
    experienceMoney:v=>'$'+v,
    document:{getElementById:id=>id==='familySize4'?target:chart}
  });
  vm.runInContext(experience.slice(experience.indexOf('let familySizeTry='),experience.indexOf('function experienceWhatIf()')),ctx);
  ctx.chooseFamilySize(4);
  expect(chart.innerHTML).toContain('3 kids · plan');
  expect(chart.innerHTML).toContain('4 kids · preview');
  const a=base.find(r=>r.yr===year),b=alt.find(r=>r.yr===year);
  expect(b.livFullParts.groceries).toBe(a.livFullParts.groceries);
  expect(b.livFullParts.clothing).toBeGreaterThan(a.livFullParts.clothing);
  expect(b.ccFull).toBeGreaterThan(a.ccFull);
  expect(chart.innerHTML).toContain(`<th scope="row">${year}</th><td>$${b.ccFull}</td>`);
  expect(chart.innerHTML).toContain(`+$${alt.reduce((n,b,i)=>n+b.tuFull-base[i].tuFull,0)}`);
  expect(JSON.stringify(p)).toBe(before);
});
