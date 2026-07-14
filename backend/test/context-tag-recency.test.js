// Bug bash: a real briefing narrated a sparse alcohol log as "third straight
// day" and "550% above usual" — Alcohol Thu, none Fri, none Sat, Alcohol
// Sun (1 of the last 3 local-calendar days, not a streak at all). Two
// compounding defects:
//  1. context:* tags (binary 0/1 daily, like habits:*) were never excluded
//     from the generic computeTrends/computeAnomalies percentage engines —
//     a single occurrence after a near-zero baseline mean produces an
//     arbitrarily large, meaningless percentage.
//  2. There was no computed, factual "how often was this actually logged
//     recently" summary — nothing prevented an LLM from inventing a streak
//     count from whatever raw context text was available.
const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../src/intelligence/analyze');

function series(dayValuePairs) {
  return dayValuePairs.map(([day, value]) => ({ day, value }));
}

// ── computeContextRecency ─────────────────────────────────────────────────────

test('computeContextRecency: Fri=0, Sat=0, Sun=1 reports "1 of the last 3 days", never a streak', () => {
  const seriesByKey = {
    'context:alcohol': series([
      ['2026-07-09', 1], // Thursday — outside the 3-day window ending Sunday
      ['2026-07-10', 0], // Friday
      ['2026-07-11', 0], // Saturday
      ['2026-07-12', 1], // Sunday
    ]),
  };
  const results = a.computeContextRecency(seriesByKey, { today: '2026-07-12', contextRecencyWindow: 3 });
  assert.equal(results.length, 1);
  const r = results[0];
  assert.equal(r.tag, 'alcohol');
  assert.equal(r.loggedDays, 1);
  assert.equal(r.windowDays, 3);
  assert.equal(r.isConsecutiveStreak, false, 'a single logged day separated by a gap is not a streak');
  assert.match(r.summary, /logged on 1 of the last 3 days/);
  assert.doesNotMatch(r.summary, /straight|consecutive/i, 'must never claim consecutive days for a single, gapped occurrence');
  assert.doesNotMatch(r.summary, /%/, 'must never use percentage-above-baseline language');
});

test('computeContextRecency: three logged days in a row correctly reports a consecutive streak', () => {
  const seriesByKey = {
    'context:alcohol': series([
      ['2026-07-10', 1], // Friday
      ['2026-07-11', 1], // Saturday
      ['2026-07-12', 1], // Sunday
    ]),
  };
  const results = a.computeContextRecency(seriesByKey, { today: '2026-07-12', contextRecencyWindow: 3 });
  assert.equal(results.length, 1);
  const r = results[0];
  assert.equal(r.loggedDays, 3);
  assert.equal(r.streakDays, 3);
  assert.equal(r.isConsecutiveStreak, true, 'a genuine uninterrupted 3-for-3 run IS a real streak');
  assert.match(r.summary, /3 consecutive days/);
});

test('computeContextRecency: a gap anywhere in the window breaks the streak, even with the same total count', () => {
  const seriesByKey = {
    'context:alcohol': series([
      ['2026-07-10', 1], // Friday
      ['2026-07-11', 0], // Saturday — the gap
      ['2026-07-12', 1], // Sunday
    ]),
  };
  const results = a.computeContextRecency(seriesByKey, { today: '2026-07-12', contextRecencyWindow: 3 });
  const r = results[0];
  assert.equal(r.loggedDays, 2);
  assert.equal(r.isConsecutiveStreak, false);
  assert.match(r.summary, /logged on 2 of the last 3 days/);
});

test('computeContextRecency: nothing logged in the window produces no result at all', () => {
  const seriesByKey = {
    'context:alcohol': series([
      ['2026-07-05', 1], // well outside the window
    ]),
  };
  const results = a.computeContextRecency(seriesByKey, { today: '2026-07-12', contextRecencyWindow: 3 });
  assert.deepEqual(results, []);
});

// ── computeTrends / computeAnomalies must never fire on a context tag ────────

function sparseAlcoholSeries() {
  // ~40 days of a near-zero baseline (alcohol logged rarely), then Thursday
  // (1), Friday (0), Saturday (0), Sunday (1) — the exact real-world shape
  // that produced "550% above usual" when this ran through the generic
  // trend/anomaly engines unfiltered.
  const out = [];
  const start = new Date('2026-06-01T12:00:00Z');
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    out.push({ day: d.toISOString().slice(0, 10), value: i % 11 === 0 ? 1 : 0 });
  }
  // Overwrite the final four days with the exact Thu/Fri/Sat/Sun fixture.
  out.push({ day: '2026-07-09', value: 1 });
  out.push({ day: '2026-07-10', value: 0 });
  out.push({ day: '2026-07-11', value: 0 });
  out.push({ day: '2026-07-12', value: 1 });
  return out;
}

test('computeTrends produces no finding at all for a sparse context tag (no "% above usual" is possible if nothing fires)', () => {
  const seriesByKey = { 'context:alcohol': sparseAlcoholSeries() };
  const findings = a.computeTrends(seriesByKey, { ...a.DEFAULTS, today: '2026-07-12' });
  assert.deepEqual(findings, [], 'context:* tags must be excluded from the generic trend engine entirely');
});

test('computeAnomalies produces no finding at all for a sparse context tag', () => {
  const seriesByKey = { 'context:alcohol': sparseAlcoholSeries() };
  const findings = a.computeAnomalies(seriesByKey, { ...a.DEFAULTS, today: '2026-07-12' });
  assert.deepEqual(findings, [], 'context:* tags must be excluded from the generic anomaly engine entirely');
});

test('DEFAULTS.trendSkip includes every context tag key', () => {
  const { CONTEXT_TAGS } = require('../src/intelligence/context-tags');
  for (const t of CONTEXT_TAGS) {
    assert.ok(a.DEFAULTS.trendSkip.includes(`context:${t.key}`), `context:${t.key} must be in trendSkip`);
  }
});
