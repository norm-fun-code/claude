// Required UI-language scenarios for the discretionary matched-pace overview
// hierarchy: exact calm phrasing for the symmetric 5-band pace scheme
// (in_line/slightly_below/comfortably_below/slightly_above/comfortably_above),
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
    paceLabel: 'slightly_above',
    previousMonthAmount: 208,
    vsPreviousMonth: { dollars: -8, pct: -4 },
    drivers: [],
    monthsBreakdown: [],
    ...overrides,
  };
}

test('required: exact calm-language phrase for "slightly above typical pace"', () => {
  assert.equal(PACE_COPY.slightly_above, 'slightly above typical pace');
  const line = paceLine(cmp());
  assert.equal(line, '18% slightly above typical pace · 4% below last month');
});

test('required: exact calm-language phrase for "in line with typical pace"', () => {
  assert.equal(PACE_COPY.in_line, 'in line with typical pace');
  const line = paceLine(cmp({ paceLabel: 'in_line', vsMedian: { dollars: 4, pct: 2 }, vsPreviousMonth: null }));
  assert.equal(line, '2% in line with typical pace');
});

test('required: exact calm-language phrase for "slightly below typical pace" (the exact reported production bug: 11% below must read "slightly", never "comfortably")', () => {
  assert.equal(PACE_COPY.slightly_below, 'slightly below typical pace');
  const line = paceLine(cmp({ paceLabel: 'slightly_below', vsMedian: { dollars: -60, pct: -11 }, vsPreviousMonth: null }));
  assert.equal(line, '11% slightly below typical pace');
  assert.doesNotMatch(line, /comfortably/);
});

test('required: exact calm-language phrase for "comfortably below typical pace"', () => {
  assert.equal(PACE_COPY.comfortably_below, 'comfortably below typical pace');
  const line = paceLine(cmp({ paceLabel: 'comfortably_below', vsMedian: { dollars: -60, pct: -30 }, vsPreviousMonth: null }));
  assert.equal(line, '30% comfortably below typical pace');
});

test('required: "well above typical pace" for a large excess', () => {
  assert.equal(PACE_COPY.comfortably_above, 'well above typical pace');
  const line = paceLine(cmp({ paceLabel: 'comfortably_above', vsMedian: { dollars: 300, pct: 150 }, vsPreviousMonth: null }));
  assert.equal(line, '150% well above typical pace');
});

test('never renders "needs attention" language for a spending-pace reading', () => {
  for (const key of Object.keys(PACE_COPY)) {
    assert.doesNotMatch(PACE_COPY[key], /needs attention/i);
  }
});

test('a suppressed (null) percentage never manufactures a number — the label alone still renders', () => {
  const line = paceLine(cmp({ vsMedian: { dollars: 40, pct: null }, vsPreviousMonth: null }));
  assert.equal(line, 'slightly above typical pace');
  assert.doesNotMatch(line, /null|NaN/);
});

test('the previous-month comparison also hides its percentage when null, without breaking the sentence', () => {
  const line = paceLine(cmp({ vsPreviousMonth: { dollars: -5, pct: null } }));
  assert.equal(line, '18% slightly above typical pace · below last month');
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
