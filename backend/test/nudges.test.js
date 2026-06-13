const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNudges, withinQuietHours } = require('../src/intelligence/nudges');

const forecast = (status, probability, goalId = 'g1', title = 'Save $20k') => ({
  type: 'forecast',
  title: `${title}: ${Math.round((probability ?? 0) * 100)}% likely to hit 20000 by Dec 1, 2026`,
  detail: 'Now 8000 → target 20000.',
  confidence: probability,
  evidence: { status, goalId, probability },
});

const leverage = (rank, score, title = 'Protect sleep tonight') => ({
  type: 'leverage',
  title,
  detail: 'Sleep is trending down.',
  evidence: { rank, score },
});

test('an off-track forecast becomes a high-priority nudge', () => {
  const n = buildNudges({ findings: [forecast('off_track', 0.2)] });
  assert.equal(n.length, 1);
  assert.equal(n[0].key, 'forecast:g1');
  assert.ok(n[0].priority > 0.8, `off-track should be loud, got ${n[0].priority}`);
  assert.match(n[0].body, /Save \$20k/);
});

test('an on-track forecast produces no nudge', () => {
  const n = buildNudges({ findings: [{ type: 'forecast', title: 'fine', confidence: 0.9, evidence: { status: 'on_track' } }] });
  assert.equal(n.length, 0);
});

test('recently-sent keys are suppressed (no nagging)', () => {
  const findings = [forecast('off_track', 0.2, 'g1')];
  const n = buildNudges({ findings, recentKeys: new Set(['forecast:g1']) });
  assert.equal(n.length, 0);
});

test('only the #1 leverage action is nudged', () => {
  // rankActions() assigns 1-based ranks (rank: i+1), so the top action is rank 1.
  const findings = [leverage(1, 0.7, 'Top move'), leverage(2, 0.6, 'Second move')];
  const n = buildNudges({ findings });
  assert.equal(n.length, 1);
  assert.match(n[0].body, /Top move/);
  assert.equal(n[0].title, "Today's highest-leverage move");
});

test('a cross-context insight becomes a proactive push, keyed by its headline', () => {
  const finding = {
    type: 'cross_context',
    title: 'Short sleep quietly drives your spending',
    detail: 'On nights under 6h, next-day discretionary spend runs ~30% higher.',
    confidence: 0.7,
    domains: ['health', 'wealth'],
  };
  const n = buildNudges({ findings: [finding] });
  assert.equal(n.length, 1);
  assert.equal(n[0].key, 'cross_context:short-sleep-quietly-drives-your-spending');
  assert.equal(n[0].title, 'NormOS connected the dots');
  assert.match(n[0].body, /Short sleep/);
  assert.ok(n[0].priority > 0.7, `cross-context should be loud, got ${n[0].priority}`);
});

test('a cross-context insight is suppressed once already sent', () => {
  const finding = { type: 'cross_context', title: 'Exercise lifts next-day focus', detail: 'x', domains: ['health', 'wellbeing'] };
  const n = buildNudges({ findings: [finding], recentKeys: new Set(['cross_context:exercise-lifts-next-day-focus']) });
  assert.equal(n.length, 0);
});

test('candidates are ranked by priority and capped by max', () => {
  const findings = [
    forecast('off_track', 0.1, 'g1', 'Goal A'), // priority ~0.95
    forecast('at_risk', 0.5, 'g2', 'Goal B'), // priority ~0.75
    leverage(1, 0.6, 'Move'), // priority 0.6
  ];
  const n = buildNudges({ findings, max: 2 });
  assert.equal(n.length, 2);
  assert.ok(n[0].priority >= n[1].priority);
  assert.equal(n[0].key, 'forecast:g1'); // loudest first
});

test('worsening high-confidence trend nudges; improving trend does not', () => {
  const worsening = { type: 'trend', title: 'Sleep down 18% over 7d (worsening)', confidence: 0.8, evidence: { metric: 'health:sleep_hours' } };
  const improving = { type: 'trend', title: 'HRV up 12% over 7d (improving)', confidence: 0.8, evidence: { metric: 'health:hrv' } };
  assert.equal(buildNudges({ findings: [worsening] }).length, 1);
  assert.equal(buildNudges({ findings: [improving] }).length, 0);
});

test('low-confidence findings fall below the interrupt threshold', () => {
  const weakTrend = { type: 'trend', title: 'Steps down (worsening)', confidence: 0.51, evidence: { metric: 'health:steps' } };
  assert.equal(buildNudges({ findings: [weakTrend] }).length, 0);
});

test('adds a check-in reminder only when none logged today', () => {
  const none = buildNudges({ findings: [], hasCheckinToday: false, asOf: new Date('2026-05-30T08:00:00Z') });
  assert.equal(none.length, 1);
  assert.match(none[0].key, /^checkin:2026-05-30$/);
  assert.match(none[0].body, /mood, energy, and focus/i);

  const done = buildNudges({ findings: [], hasCheckinToday: true });
  assert.equal(done.length, 0);
});

test('check-in reminder is suppressed once already sent today', () => {
  const out = buildNudges({
    findings: [], hasCheckinToday: false,
    asOf: new Date('2026-05-30T08:00:00Z'),
    recentKeys: new Set(['checkin:2026-05-30']),
  });
  assert.equal(out.length, 0);
});

test('quiet hours wrap midnight (21:00–07:00 by default)', () => {
  assert.equal(withinQuietHours(new Date('2026-05-30T03:00:00')), true);
  assert.equal(withinQuietHours(new Date('2026-05-30T22:00:00')), true);
  assert.equal(withinQuietHours(new Date('2026-05-30T07:30:00')), false);
  assert.equal(withinQuietHours(new Date('2026-05-30T12:00:00')), false);
});
