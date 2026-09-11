import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const M=require('../public/model.js');
const T=require('../public/advisor-tools.js');
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const P=vm.runInNewContext('('+html.match(/const D=(\{[\s\S]*?\n\});/)[1]+')');

describe('An unknown parameter is an error, not a no-op',()=>{
  it('refuses the whole call rather than running a scenario missing one change',()=>{
    const r=T.compute({P,overrides:{homePrice:2500000,inflationExpectation:0.04}});
    expect(r.error).toMatch(/inflationExpectation/);
    expect(r.metrics).toBe(undefined);
    // And it says what IS valid, so the model can correct itself.
    expect(r.error).toMatch(/homePrice/);
  });

  it('catches a rate entered as a percentage',()=>{
    const r=T.compute({P,overrides:{investReturn:6}});
    expect(r.error).toMatch(/outside the plausible range/);
    expect(r.error).toMatch(/0\.06, not 6/);
  });

  it('catches a percentage entered as a decimal',()=>{
    expect(T.compute({P,overrides:{mortgageRate:0.065}}).error).toBe(undefined); // 0.065% is odd but legal
    expect(T.compute({P,overrides:{downPctg:150}}).error).toMatch(/outside the plausible range/);
  });

  it('validates an enum against its actual options',()=>{
    expect(T.compute({P,overrides:{stripePolicy:'hold'}}).error).toMatch(/deficit, floor, pct, retain, sell/);
    expect(T.compute({P,overrides:{stripePolicy:'retain'}}).error).toBe(undefined);
  });

  it('accepts indexed per-year keys, and rejects ones past the window',()=>{
    expect(T.validateOverride('normStockY3',200000).ok).toBe(true);
    expect(T.validateOverride('normStockY40',200000).ok).toBe(false);
    expect(T.validateOverride('normStockY40',200000).error).toMatch(/normStockY10/);
  });

  it('says when a change changes nothing',()=>{
    const r=T.compute({P,overrides:{homePrice:P.homePrice}});
    expect(r.applied.homePrice.noop).toBe(true);
  });
});

describe('compute returns figures from the engine, with its assumptions',()=>{
  it('matches the engine exactly',()=>{
    const r=T.compute({P,metrics:['finalNetWorth','liquidFloor','drawYears']});
    const truth=M.run(P);
    // The advisor quotes this as "Net worth at plan end", so it must be the TOTAL. The
    // engine's `nw` excludes retirement; reading it here understated the answer by the
    // whole 401(k) — $4.7M at the end of this plan.
    expect(r.metrics.finalNetWorth.value).toBe(truth.R[truth.R.length-1].netWorth);
    expect(r.metrics.liquidFloor.value).toBe(Math.min(...truth.R.map(x=>x.liq)));
    expect(r.metrics.drawYears.value).toBe(truth.drawYears);
  });

  it('states the assumptions behind the answer without being asked',()=>{
    const r=T.compute({P});
    expect(r.assumptions.portfolioReturn).toBe(P.investReturn);
    expect(r.assumptions.expenseInflation).toBe(P.expenseInflation);
    expect(r.assumptions.stripePolicy).toBeTruthy();
    expect(r.assumptions.vestWithholdingRate).toBeGreaterThan(0);
    expect(r.assumptions.planYears).toMatch(/^\d{4}–\d{4}$/);
    expect(r.note).toMatch(/not forecasts/);
  });

  it('lists the metrics it knows when asked for one it does not',()=>{
    const r=T.compute({P,metrics:['sharpeRatio']});
    expect(r.unknownMetrics).toEqual(['sharpeRatio']);
    expect(r.availableMetrics).toContain('finalNetWorth');
  });

  it('reports an empty projection as an error rather than throwing',()=>{
    // planEndYear before planStartYear produces no rows. Every metric would read off an
    // empty array — this must come back as a message, not an exception or an undefined.
    const r=T.compute({P:{...P,planStartYear:2026,planEndYear:2020}});
    expect(r.error).toMatch(/no projection years/);
    expect(r.metrics).toBe(undefined);
  });
});

describe('compare_alternatives measures rather than argues',()=>{
  const alts=[
    {name:'Current plan',overrides:{}},
    {name:'$500K cheaper',overrides:{homePrice:P.homePrice-500000}},
    {name:'Two years later',overrides:{homePurchaseYear:P.homePurchaseYear+2}},
  ];

  it('needs at least two alternatives',()=>{
    expect(T.compareAlternatives({P,alternatives:[alts[0]]}).error).toMatch(/at least two/);
    expect(T.compareAlternatives({P,alternatives:[]}).error).toMatch(/at least two/);
  });

  it('refuses an unreadable number of them',()=>{
    const many=Array.from({length:7},(_,i)=>({name:'alt'+i,overrides:{}}));
    expect(T.compareAlternatives({P,alternatives:many}).error).toMatch(/at most six/);
  });

  it('sorts by the metric the alternatives actually disagree about',()=>{
    const c=T.compareAlternatives({P,alternatives:alts});
    expect(c.comparison[0].spread).toBeGreaterThanOrEqual(c.comparison[1].spread??0);
    expect(c.comparison[0].values).toHaveLength(3);
  });

  it('names any assumption that is NOT shared, because the comparison turns on it',()=>{
    const c=T.compareAlternatives({P,alternatives:[
      {name:'6% returns',overrides:{investReturn:0.06}},
      {name:'4% returns',overrides:{investReturn:0.04}},
    ]});
    const d=c.differingAssumptions.find(x=>x.assumption==='portfolioReturn');
    expect(d).toBeTruthy();
    expect(d.values.map(v=>v.value)).toEqual([0.06,0.04]);
    expect(c.note).toMatch(/do not share every assumption/);
  });

  it('says so plainly when the alternatives are like-for-like',()=>{
    const c=T.compareAlternatives({P,alternatives:[
      {name:'A',overrides:{homePrice:2000000}},
      {name:'B',overrides:{homePrice:2500000}},
    ]});
    expect(c.differingAssumptions).toEqual([]);
    expect(c.note).toMatch(/only to the changes listed/);
  });

  it('fails the whole comparison if one alternative is invalid',()=>{
    const c=T.compareAlternatives({P,alternatives:[
      {name:'Good',overrides:{}},{name:'Bad',overrides:{notAThing:1}},
    ]});
    expect(c.error).toMatch(/Bad:/);
    expect(c.comparison).toBe(undefined);
  });
});

describe('A tax figure always arrives with its year, jurisdiction and source',()=>{
  it('never returns a bare number',()=>{
    const r=T.lookupTaxRule({ruleId:'fedBracketsMFJ',today:'2026-09-10'});
    expect(r.taxYear).toBe(2026);
    expect(r.jurisdiction).toBe('US-Federal');
    expect(r.filingStatus).toBe('MFJ');
    expect(r.source.url).toMatch(/^https:\/\//);
    expect(r.source.retrieved).toBeTruthy();
    expect(r.source.citation).toBeTruthy();
    expect(r.citation).toMatch(/retrieved/);
  });

  it('says whether the figure moves with inflation on its own',()=>{
    expect(T.lookupTaxRule({ruleId:'fedBracketsMFJ'}).indexedForInflation).toBe(true);
    expect(T.lookupTaxRule({ruleId:'nysBracketsMFJ'}).indexedForInflation).toBe(false);
    expect(T.lookupTaxRule({ruleId:'niitMFJ'}).indexedForInflation).toBe(false);
  });

  it('carries a caveat that escalates once the table is out of date',()=>{
    expect(T.lookupTaxRule({ruleId:'saltCap',today:'2026-09-10'}).caveat)
      .toMatch(/Say the year and jurisdiction/);
    const stale=T.lookupTaxRule({ruleId:'saltCap',today:'2028-03-01'});
    expect(stale.caveat).toMatch(/^WARNING/);
    expect(stale.caveat).toMatch(/re-read/i);
  });

  it('lists what it has rather than guessing at an unknown rule',()=>{
    const r=T.lookupTaxRule({ruleId:'estateTaxExemption'});
    expect(r.error).toMatch(/Available:/);
    expect(r.error).toMatch(/fedBracketsMFJ/);
  });
});

describe('Proposals and decisions are staged, never written',()=>{
  it('returns the impact against doing nothing, and says nothing changed',()=>{
    const r=T.proposeChanges({P,overrides:{homePrice:P.homePrice-400000},
      rationale:'Restore the reserve floor without delaying the purchase.'});
    expect(r.status).toBe('proposed');
    expect(r.note).toMatch(/NOTHING HAS BEEN CHANGED/);
    expect(r.impact.finalNetWorth.from).toBeTruthy();
    expect(r.impact.finalNetWorth.to).toBeTruthy();
    expect(typeof r.impact.finalNetWorth.delta).toBe('number');
  });

  it('will not stage a proposal with no reasoning',()=>{
    expect(T.proposeChanges({P,overrides:{homePrice:1}}).error).toMatch(/rationale/);
  });

  it('warns when the proposal is smaller than it looks',()=>{
    const r=T.proposeChanges({P,overrides:{homePrice:P.homePrice},rationale:'Test.'});
    expect(r.warning).toMatch(/already had the proposed value/);
  });

  it('requires a decision to carry its reasoning',()=>{
    const r=T.recordDecision({title:'Hold Stripe',reconsiderWhen:[
      {metric:'stripeShare',op:'gt',value:0.6,description:'Stripe passes 60% of net worth'}]});
    expect(r.error).toMatch(/second-guessed/);
  });

  it('requires a way for the decision to come back',()=>{
    const r=T.recordDecision({title:'Hold Stripe',rationale:'A higher mark is expected.'});
    expect(r.error).toMatch(/nothing will ever bring it back/);
  });

  it('rejects a trigger the monitors could never evaluate',()=>{
    const r=T.recordDecision({title:'Hold Stripe',rationale:'Because.',
      reconsiderWhen:[{metric:'vibes',op:'gt',value:1,description:'things feel bad'}]});
    expect(r.error).toMatch(/never fire/);
    expect(r.error).toMatch(/stripeShare/);   // says what IS measurable
  });

  it('rejects a condition with no plain-language description',()=>{
    const r=T.recordDecision({title:'Hold Stripe',rationale:'Because.',
      reconsiderWhen:[{metric:'stripeShare',op:'gt',value:0.6}]});
    expect(r.error).toMatch(/plain-language description/);
  });

  it('stages a well-formed decision without saving it',()=>{
    const r=T.recordDecision({title:'Hold Stripe through the 2027 tender',
      choice:'Retain','rationale':'A higher mark is expected at the Q1 2027 tender.',
      alternatives:['Sell 30% at the Q4 tender'],
      reconsiderWhen:[{metric:'stripeShare',op:'gt',value:0.6,
        description:'Stripe passes 60% of net worth'}]},{now:'2026-09-10T00:00:00Z'});
    expect(r.status).toBe('proposed');
    expect(r.note).toMatch(/NOT YET SAVED/);
    expect(r.decision.id).toMatch(/^dec_/);
    expect(r.decision.status).toBe('active');
  });

  it('accepts a review date in place of a condition',()=>{
    const r=T.recordDecision({title:'Rent another year',rationale:'Schools undecided.',
      reviewBy:'2027-03-01'});
    expect(r.status).toBe('proposed');
  });
});

describe('The tool schemas tell the model the right things',()=>{
  const byName=Object.fromEntries(T.TOOLS.map(t=>[t.name,t]));

  it('offers every tool the advisor needs',()=>{
    expect(Object.keys(byName).sort()).toEqual([
      'compare_alternatives','compute','get_alerts','get_tax_position',
      'lookup_tax_rule','propose_changes','record_decision'].sort());
  });

  it('tells the model not to do arithmetic itself',()=>{
    expect(byName.compute.description).toMatch(/never calculate in your head/i);
  });

  it('tells the model not to quote a tax figure from memory',()=>{
    expect(byName.lookup_tax_rule.description).toMatch(/do not quote a tax figure from memory/i);
    expect(byName.lookup_tax_rule.description).toMatch(/state the year and jurisdiction/i);
  });

  it('tells the model it may explain alerts but never invent them',()=>{
    expect(byName.get_alerts.description).toMatch(/must NOT report a condition it did not detect/);
    expect(byName.get_alerts.description).toMatch(/skipped/);
  });

  it('tells the model that write tools do not write',()=>{
    expect(byName.propose_changes.description).toMatch(/NEVER modifies/);
    expect(byName.record_decision.description).toMatch(/nothing is saved until the user accepts/);
  });

  it('enumerates the real options inside the schemas, not placeholders',()=>{
    expect(byName.compute.input_schema.properties.metrics.description).toMatch(/finalNetWorth/);
    expect(byName.lookup_tax_rule.input_schema.properties.ruleId.description).toMatch(/nysBracketsMFJ/);
    const cond=byName.record_decision.input_schema.properties.reconsiderWhen.items.properties;
    expect(cond.metric.description).toMatch(/stripeShare/);
    expect(cond.op.description).toMatch(/gt/);
  });
});

// The grounding rules are constraints on how the advisor may SPEAK, which no tool schema
// can enforce. They live in server.js, so this asserts they are actually wired in.
describe('The advisor is grounded in the prompt as well as the tools',()=>{
  const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');

  it('hands the planner tools to the model alongside the Monarch ones',()=>{
    expect(server).toContain('tools: [...AdvisorTools.TOOLS, ...monarchTools]');
  });

  it('routes planner tool calls to the tested executors',()=>{
    expect(server).toContain('PLANNER_TOOL_NAMES.has(block.name)');
    expect(server).toContain('runPlannerTool(block.name');
  });

  it('returns a tool failure as a failure the model can see',()=>{
    expect(server).toMatch(/tool failed/);
    expect(server).toMatch(/not\s*\n?\s*\/\/ as an absence it might fill in|as an absence it might fill in/);
  });

  it('states every rule the tools cannot enforce',()=>{
    const g=server.slice(server.indexOf('function advisorGrounding'),
      server.indexOf('// ── Anthropic proxy'));
    expect(g).toMatch(/Do not do arithmetic yourself/);
    expect(g).toMatch(/Never quote a tax figure from memory/);
    expect(g).toMatch(/never report a condition it did not detect/);
    expect(g).toMatch(/You never modify the plan/);
    expect(g).toMatch(/A projection is not a forecast/);
    expect(g).toMatch(/name the document it\s*\n?comes from/);
    expect(g).toMatch(/requiresConfirmation/);
  });

  it('tells the advisor when its own rule table has gone stale',()=>{
    const g=server.slice(server.indexOf('function advisorGrounding'),
      server.indexOf('// ── Anthropic proxy'));
    expect(g).toMatch(/staleness\.coversCurrentYear/);
    expect(g).toMatch(/IT IS NOW OUT OF DATE/);
  });

  it('adds the grounding to every advisor turn, not just the first',()=>{
    expect(server).toContain('const sys = systemPrompt + grounding');
  });
});
