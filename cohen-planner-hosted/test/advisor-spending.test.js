import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

// ── The advisor could not read a transaction it was sitting on ───────────────
// It told the household "the transaction-level data isn't accessible through my current
// Monarch connection — I can see balances, not transactions" and sent them off to export a
// category report by hand, while 6,149 imported transactions sat in the ledger the Spending
// tab was already drawing from. That was true of its TOOLS, not of the data: its only
// account-side tool was monarch_GetAccounts, balances and nothing else.

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

function runTool(input, report, hasPlan = true) {
  const source = server.slice(server.indexOf('async function runPlannerTool'),
    server.indexOf('const PLANNER_TOOL_NAMES'));
  const ctx = {
    db: { query: async () => ({ rows: hasPlan ? [{ state: { P: {} } }] : [] }) },
    migrateP: p => p,
    AdvisorTools: {},
    spendingReport: async () => report,
    Date, Math, Number, Set, Map, JSON, console,
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return ctx.runPlannerTool('get_spending', input);
}

// A ledger with two closed months and a third in progress. Only February's import was
// verified end-to-end; January's records are real but unconfirmed.
const REPORT = {
  startDate: '2026-01-01', endDate: '2026-03-16',
  coverage: { first: '2026-01', completeMonths: ['2026-02'], partial: '2026-03', fractionElapsed: 0.5161 },
  months: [
    { month: '2026-01', income: 40000, expense: 12000, categories: [
      { id: 'r', name: 'Rent', net: 8000, refunds: 0 }, { id: 'g', name: 'Groceries', net: 4000, refunds: 200 }] },
    { month: '2026-02', income: 40000, expense: 14000, categories: [
      { id: 'r', name: 'Rent', net: 8000, refunds: 0 }, { id: 'g', name: 'Groceries', net: 6000, refunds: 0 }] },
    { month: '2026-03', income: 20000, expense: 5000, categories: [
      { id: 'r', name: 'Rent', net: 4000, refunds: 0 }] },
  ],
  totals: { transfer: 90000, cardPayment: 30000, investment: 20000, hidden: 1500 },
  counts: {}, rolling: { m3: null, m6: null, m12: null },
  pace: { status: 'ok' },
};

describe('get_spending hands the advisor the ledger it already holds', () => {
  it('averages categories over CLOSED months, so the month in progress cannot drag them down', async () => {
    const r = await runTool({}, REPORT);
    const by = Object.fromEntries(r.categoriesPerMonth.map(c => [c.name, c]));
    expect(by.Rent.perMonth).toBe(8000);          // 16000 over two closed months, not 20000/3
    expect(by.Groceries.perMonth).toBe(5000);
    expect(by.Groceries.refunds).toBe(200);
    expect(r.monthly.map(m => m.month)).toEqual(['2026-01', '2026-02']);
    expect(r.currentMonthSoFar).toEqual({ month: '2026-03', income: 20000, spending: 5000 });
  });

  it('reports what the ledger HOLDS and what was verified as two different numbers', async () => {
    // Reporting only the verified count is what made a ledger holding years of records
    // announce itself as "0 complete months of transaction history synced".
    const r = await runTool({}, REPORT);
    expect(r.coverage.monthsWithRecords).toBe(2);
    expect(r.coverage.verifiedCompleteMonths).toBe(1);
    expect(r.monthly.find(m => m.month === '2026-01').verified).toBe(false);
    expect(r.monthly.find(m => m.month === '2026-02').verified).toBe(true);
    expect(r.coverage.monthInProgress).toBe('2026-03');
  });

  it('carries the deliberate exclusions, so the advisor can say why spending looks low', async () => {
    const r = await runTool({}, REPORT);
    expect(r.excluded.transfers).toBe(90000);
    expect(r.excluded.cardPayments).toBe(30000);
    expect(r.excluded.hiddenInMonarch).toBe(1500);
    expect(r.excluded.note).toMatch(/not consumption/i);
  });

  it('says a null trailing average is unverified coverage, not zero spending', async () => {
    const r = await runTool({}, REPORT);
    expect(r.trailingAveragePerMonth.m12).toBeNull();
    expect(r.trailingAveragePerMonth.note).toMatch(/not that spending was zero/i);
  });

  it('answers before a plan is saved, because it reads the ledger and not the plan', async () => {
    const r = await runTool({}, REPORT, false);
    expect(r.error).toBeUndefined();
    expect(r.coverage.monthsWithRecords).toBe(2);
  });

  it('survives an empty ledger without inventing a month', async () => {
    const r = await runTool({}, { ...REPORT, months: [],
      coverage: { first: null, completeMonths: [], partial: null, fractionElapsed: 0.5 } });
    expect(r.coverage.monthsWithRecords).toBe(0);
    expect(r.coverage.lastClosedMonth).toBeNull();
    expect(r.currentMonthSoFar).toBeNull();
    expect(r.categoriesPerMonth).toEqual([]);
  });

  it('bounds the history it will read rather than trusting the model\'s number', async () => {
    const source = server.slice(server.indexOf("case 'get_spending'"), server.indexOf("case 'get_tax_position'"));
    expect(source).toContain('Math.max(1, Math.min(60, Number(input && input.months) || 24))');
  });
});

describe('what the advisor is told about the ledger', () => {
  it('is pointed at the tool and told not to ask for an export', () => {
    const grounding = server.slice(server.indexOf('function advisorGrounding'),
      server.indexOf("app.post('/api/advisor/stream'"));
    expect(grounding).toMatch(/get_spending reads the imported transaction ledger/);
    expect(grounding).toMatch(/Never tell the user to export a report from Monarch/);
    // Unverified coverage is a missing confirmation, not missing records.
    expect(grounding).toMatch(/NOT the records/);
  });

  it('is told records exist when coverage is merely unconfirmed', () => {
    // buildMonitorContext fed get_alerts "only 0 complete months", which the advisor
    // faithfully relayed as "0 complete months of transaction history synced".
    expect(server).toContain('months of records, but only ${cov.completeMonths.length} verified complete');
    expect(server).toContain("'no transactions imported yet'");
    expect(server).not.toContain('`only ${cov.completeMonths.length} complete months`');
  });

  it('reads the ledger through the same code path the Spending tab does', () => {
    // Two readers of one ledger that computed coverage separately would eventually disagree
    // about whether a month counted, and only one of them is on screen to be checked.
    expect(server).toContain('async function spendingReport({ startDate, endDate, committed } = {})');
    expect(server).toContain('res.json(await spendingReport({ startDate, endDate,');
    expect(server).toContain('const r = await spendingReport({ startDate, endDate });');
  });
});
