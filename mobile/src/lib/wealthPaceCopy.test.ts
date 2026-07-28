// Required UI-language scenarios for the discretionary matched-pace overview
// hierarchy: exact calm phrasing for above/near/below typical pace,
// percentage suppression, and the driver line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { paceLine, driverLine, PACE_COPY, type PaceComparison } from './wealthPaceCopy.ts';

function cmp(overrides: Partial<PaceComparison> = {}): PaceComparison {
  return {
    coverageTier: 'typical',
    monthsUsed: 8,
    monthsConsidered: 12,
    medianBaseline: 200,
    vsMedian: { dollars: 36, pct: 18 },
    paceLabel: 'above_typical',
    previousMonthAmount: 208,
    vsPreviousMonth: { dollars: -8, pct: -4 },
    drivers: [],
    monthsBreakdown: [],
    ...overrides,
  };
}

test('required: exact calm-language phrase for "above typical pace"', () => {
  assert.equal(PACE_COPY.above_typical, 'above typical pace');
  const line = paceLine(cmp());
  assert.equal(line, '18% above typical pace · 4% below last month');
});

test('required: exact calm-language phrase for "near typical pace"', () => {
  assert.equal(PACE_COPY.near_typical, 'near typical pace');
  const line = paceLine(cmp({ paceLabel: 'near_typical', vsMedian: { dollars: 4, pct: 2 }, vsPreviousMonth: null }));
  assert.equal(line, '2% near typical pace');
});

test('required: exact calm-language phrase for "below typical pace"', () => {
  assert.equal(PACE_COPY.below_typical, 'below typical pace');
  const line = paceLine(cmp({ paceLabel: 'below_typical', vsMedian: { dollars: -60, pct: -30 }, vsPreviousMonth: null }));
  assert.equal(line, '30% below typical pace');
});

test('required: "well above typical pace" for a large excess', () => {
  assert.equal(PACE_COPY.well_above_typical, 'well above typical pace');
  const line = paceLine(cmp({ paceLabel: 'well_above_typical', vsMedian: { dollars: 300, pct: 150 }, vsPreviousMonth: null }));
  assert.equal(line, '150% well above typical pace');
});

test('never renders "needs attention" language for a spending-pace reading', () => {
  for (const key of Object.keys(PACE_COPY)) {
    assert.doesNotMatch(PACE_COPY[key], /needs attention/i);
  }
});

test('a suppressed (null) percentage never manufactures a number — the label alone still renders', () => {
  const line = paceLine(cmp({ vsMedian: { dollars: 40, pct: null }, vsPreviousMonth: null }));
  assert.equal(line, 'above typical pace');
  assert.doesNotMatch(line, /null|NaN/);
});

test('the previous-month comparison also hides its percentage when null, without breaking the sentence', () => {
  const line = paceLine(cmp({ vsPreviousMonth: { dollars: -5, pct: null } }));
  assert.equal(line, '18% above typical pace · below last month');
});

test('required: driver line names real computed excess dollars, capped at what the server returned (0-2 entries)', () => {
  assert.equal(driverLine([]), null, 'no line at all when nothing is elevated');
  assert.equal(
    driverLine([{ category: 'Clothing', currentAmount: 500, matchedMedian: 150, excessDollars: 350, pct: null }]),
    'Driven by Clothing +$350'
  );
  assert.equal(
    driverLine([
      { category: 'Clothing', currentAmount: 500, matchedMedian: 150, excessDollars: 350, pct: null },
      { category: 'Entertainment', currentAmount: 400, matchedMedian: 220, excessDollars: 180, pct: 82 },
    ]),
    'Driven by Clothing +$350 and Entertainment +$180'
  );
});
