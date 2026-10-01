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
    expect(server).toContain('A named living category was requested. Do not use expenseAdjY.');
    expect(html).toContain('Any earlier chat message claiming this is unsupported is stale and must be corrected.');
    expect(html).toContain('advEditExpenseProposal');
    expect(html).toContain('aria-label="Expense category"');
    expect(html).toContain('aria-label="Expense year"');
  });
});

describe('inputs and safe presentation mode',()=>{
  it('reaches Inputs from a gear in the header, not a tab in the rail',()=>{
    expect(html).toContain('id="inputsGear"');
    expect(html).toContain("onclick=\"setTab('inputs')\" aria-label=\"Plan inputs\"");
    expect(html).not.toContain('data-tab="inputs"');
  });

  it('keeps demo data in memory and blocks private write/read paths',()=>{
    expect(html).toContain("['◈','Present with demo numbers','enterDemoMode()']");
    expect(html).toContain("if(typeof _demoMode!=='undefined'&&_demoMode)return;");
    expect(html).toMatch(/async function loadOverview\(\)\{\s*if\(_demoMode\)return;/);
    expect(html).toMatch(/async function loadSpending\(\)\{\s*if\(_demoMode\)return;/);
    // The advisor shows one computed example instead of a paused page, and still cannot send.
    expect(html).toContain('async function advSend(){\n  if(_demoMode)return;');
    expect(html).toContain('Live questions are off in the demo — nothing is sent anywhere.');
    expect(html).toContain('fictional numbers only');
    expect(html).toContain('function exitDemoMode(){location.reload()}');
  });

  it('keeps one case control in the header, and the live baseline when switching',()=>{
    expect(html).toContain('id="caseControl"');
    expect(html).toContain('function renderCaseControl()');
    expect(html).toContain('function selectLivePlan()');
    expect(html).toContain('livePlanParams');
    expect(html).not.toContain('renderInputScenarioSwitcher');
  });
});
