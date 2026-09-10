import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const S = require('../public/snapshots.js');

const snap = (asOf, netWorth, over = {}) => ({
  asOf, netWorth, complete: true,
  byClass: { cash: { total: 60000 }, taxable: { total: netWorth - 60000 } },
  ...over,
});
const FULL = { firstDate: '2025-01-01', lastDate: '2026-12-31' };

describe('window coverage', () => {
  it('is not covered when no transactions have been imported', () => {
    const c = S.windowCoverage(snap('2026-06-01', 1000000), snap('2026-09-01', 1040000), null);
    expect(c.covered).toBe(false);
    expect(c.reason).toMatch(/no transaction history/i);
  });

  it('is not covered when history starts after the window opens', () => {
    const c = S.windowCoverage(snap('2026-01-01', 1e6), snap('2026-09-01', 1e6),
      { firstDate: '2026-06-01', lastDate: '2026-12-31' });
    expect(c.covered).toBe(false);
    expect(c.reason).toMatch(/starts 2026-06-01/);
  });

  it('is not covered when history ends before the window closes', () => {
    const c = S.windowCoverage(snap('2026-01-01', 1e6), snap('2026-09-01', 1e6),
      { firstDate: '2025-01-01', lastDate: '2026-07-01' });
    expect(c.covered).toBe(false);
    expect(c.reason).toMatch(/ends 2026-07-01/);
  });

  it('is covered when history spans the whole window', () => {
    const c = S.windowCoverage(snap('2026-06-01', 1e6), snap('2026-09-01', 1e6), FULL);
    expect(c.covered).toBe(true);
    expect(c.days).toBe(92);
  });
});

// ── The central rule ─────────────────────────────────────────────────────
describe('a balance change alone explains nothing', () => {
  it('attributes NOTHING without transaction coverage', () => {
    const e = S.explainChange(snap('2026-06-01', 1000000), snap('2026-09-01', 1120000), null, null);
    expect(e.delta).toBe(120000);
    expect(e.components).toHaveLength(0);           // no decomposition attempted
    expect(e.residual.confidence).toBe(S.CONFIDENCE.UNSUPPORTED);
    expect(e.residual.amount).toBe(120000);
    expect(e.residual.label).toBe('Not explained');
  });

  it('never calls an unexplained rise investment performance', () => {
    const e = S.explainChange(snap('2026-06-01', 1e6), snap('2026-09-01', 1.2e6), null, null);
    const text = JSON.stringify(e).toLowerCase();
    expect(text).not.toMatch(/\breturn(ed)?\b.*%|performance|gained|earned/);
    expect(e.residual.detail).toMatch(/cannot show whether/i);
  });

  it('refuses partial coverage rather than explaining half a window', () => {
    const e = S.explainChange(snap('2026-01-01', 1e6), snap('2026-09-01', 1.1e6),
      { income: 90000, spending: 40000 }, { firstDate: '2026-06-01', lastDate: '2026-12-31' });
    expect(e.components).toHaveLength(0);
    expect(e.residual.confidence).toBe(S.CONFIDENCE.UNSUPPORTED);
  });
});

describe('decomposition where the data supports it', () => {
  const from = snap('2026-06-01', 1000000), to = snap('2026-09-01', 1120000);
  const flows = { income: 78000, spending: 33000 };

  it('measures income and spending from transactions', () => {
    const e = S.explainChange(from, to, flows, FULL);
    const inc = e.components.find(c => c.key === 'income');
    const spend = e.components.find(c => c.key === 'spending');
    expect(inc.amount).toBe(78000);
    expect(inc.confidence).toBe(S.CONFIDENCE.MEASURED);
    expect(spend.amount).toBe(-33000);               // signed as a reduction
  });

  it('leaves the rest as a residual that adds back to the observed change', () => {
    const e = S.explainChange(from, to, flows, FULL);
    const netFlow = e.components.find(c => c.key === 'netFlow').amount;
    expect(netFlow).toBe(45000);
    expect(e.residual.amount).toBe(120000 - 45000);
    expect(netFlow + e.residual.amount).toBe(e.delta); // the decomposition is complete
  });

  it('still calls the residual a difference, not a measured return', () => {
    const e = S.explainChange(from, to, flows, FULL);
    expect(e.residual.confidence).toBe(S.CONFIDENCE.RESIDUAL);
    expect(e.residual.label).toMatch(/not explained by transactions/i);
    expect(e.residual.detail).toMatch(/consistent with/i);       // hedged
    expect(e.residual.detail).toMatch(/not a measured return/i); // and says so outright
    expect(e.residual.detail).toMatch(/unsynced account|stale price/i);
  });

  it('handles a fall as readily as a rise', () => {
    const e = S.explainChange(snap('2026-06-01', 1.2e6), snap('2026-09-01', 1.05e6),
      { income: 60000, spending: 90000 }, FULL);
    expect(e.delta).toBe(-150000);
    expect(e.components.find(c => c.key === 'netFlow').amount).toBe(-30000);
    expect(e.residual.amount).toBe(-120000);
  });

  it('omits components that are genuinely zero rather than showing empty rows', () => {
    const e = S.explainChange(from, to, { income: 0, spending: 0 }, FULL);
    expect(e.components.map(c => c.key)).toEqual(['netFlow']);
    expect(e.residual.amount).toBe(120000);
  });
});

// ── Observation vs. attribution ──────────────────────────────────────────
describe('per-class movement', () => {
  it('reports where the change landed without claiming why', () => {
    const rows = S.classDeltas(
      { byClass: { cash: { total: 60000 }, taxable: { total: 500000 }, retirement: { total: 200000 } } },
      { byClass: { cash: { total: 42000 }, taxable: { total: 560000 }, retirement: { total: 210000 } } });
    expect(rows[0]).toMatchObject({ cls: 'taxable', delta: 60000 }); // largest first
    expect(rows.find(r => r.cls === 'cash').delta).toBe(-18000);
    // it is a pure difference: no confidence field, because nothing is being attributed
    expect(rows[0].confidence).toBeUndefined();
  });

  it('skips classes that are empty on both sides', () => {
    const rows = S.classDeltas({ byClass: { debt: { total: 0 } } }, { byClass: { debt: { total: 0 } } });
    expect(rows).toHaveLength(0);
  });
});

// ── Comparability ────────────────────────────────────────────────────────
describe('snapshot comparability', () => {
  it('refuses a snapshot taken while a balance was unknown', () => {
    const c = S.comparable(snap('2026-06-01', 1e6, { complete: false }));
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/short by an unknown amount/i);
  });

  it('refuses a snapshot with no net worth', () => {
    expect(S.comparable({ asOf: '2026-06-01' }).ok).toBe(false);
    expect(S.comparable(null).ok).toBe(false);
  });

  it('accepts a complete one', () => {
    expect(S.comparable(snap('2026-06-01', 1e6)).ok).toBe(true);
  });
});
