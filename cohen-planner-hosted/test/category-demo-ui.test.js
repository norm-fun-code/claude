import {describe,it,expect} from 'vitest';
import fs from 'node:fs';

const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');

describe('advisor category proposals',()=>{
  it('offers a dedicated category tool and editable year/category proposal controls',()=>{
    expect(server).toContain("name: 'set_expense_category'");
    expect(server).toContain('Named-category changes are NOT one-offs');
    expect(server).toContain("enum: ['set','increase','decrease']");
    expect(server).toContain("operation==='increase'?old+dollars");
    expect(html).toContain('advEditExpenseProposal');
    expect(html).toContain('aria-label="Expense category"');
    expect(html).toContain('aria-label="Expense year"');
  });
});

describe('inputs and safe presentation mode',()=>{
  it('makes Inputs a top-level tab immediately after Advisor',()=>{
    expect(html).toMatch(/data-tab="advisor"[\s\S]*?data-tab="inputs"/);
  });

  it('keeps demo data in memory and blocks private write/read paths',()=>{
    expect(html).toContain("['◈','Present with demo numbers','enterDemoMode()']");
    expect(html).toContain("if(typeof _demoMode!=='undefined'&&_demoMode)return;");
    expect(html).toMatch(/async function loadOverview\(\)\{\s*if\(_demoMode\)return;/);
    expect(html).toMatch(/async function loadSpending\(\)\{\s*if\(_demoMode\)return;/);
    expect(html).toContain('Advisor paused in Demo Mode');
    expect(html).toContain('fictional numbers only');
    expect(html).toContain('function exitDemoMode(){location.reload()}');
  });
});
