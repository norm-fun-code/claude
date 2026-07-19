// Unit coverage for intelligence/weeklyLedger.js — the canonical weekly
// event ledger that fixes the Weekly Review bug where a single overnight
// episode (Wednesday evening into early Thursday morning) was reported as
// "two nights of alcohol + late meals (Wed/Thu)". Pure logic only, no DB —
// see test/integration/weekly-ledger-*.test.js for the DB-touching
// eligibility/dedup coverage (retirement, negation, supersession, raw/
// compiled dedup against a real Postgres).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  episodeDateFor, groupIntoEpisodes, buildAggregates, nightsWithBothConcepts,
  isEligibleRawAnnotation, assertionsToItems, coveredAnnotationIdsFrom,
  excludeCoveredAnnotations, rawAnnotationsToItems,
} = require('../src/intelligence/weeklyLedger');

const TZ = 'America/New_York';

// ── episodeDateFor ──────────────────────────────────────────────────────

test('episodeDateFor: an evening timestamp belongs to its own calendar date', () => {
  // 11pm Wednesday July 15 2026 ET.
  assert.equal(episodeDateFor('2026-07-16T03:00:00Z', TZ), '2026-07-15');
});

test('episodeDateFor: an early-morning timestamp belongs to the PREVIOUS date\'s episode', () => {
  // 12:30am Thursday July 16 2026 ET — still part of "Wednesday night".
  assert.equal(episodeDateFor('2026-07-16T04:30:00Z', TZ), '2026-07-15');
});

test('episodeDateFor: a daytime timestamp belongs to its own calendar date', () => {
  // 2pm Wednesday July 15 2026 ET.
  assert.equal(episodeDateFor('2026-07-15T18:00:00Z', TZ), '2026-07-15');
});

test('episodeDateFor: applies uniformly regardless of concept — general, not event-specific', () => {
  // Same mechanism for an arbitrary early-morning timestamp with no concept
  // context at all attached (episodeDateFor only ever sees the timestamp).
  const d1 = episodeDateFor('2026-01-01T05:00:00Z', TZ); // 12am Jan 1 ET
  const d2 = episodeDateFor('2026-12-25T05:00:00Z', TZ); // 12am Dec 25 ET
  assert.equal(d1, '2025-12-31');
  assert.equal(d2, '2026-12-24');
});

// ── groupIntoEpisodes — required regression tests 1, 2, 3 ───────────────

test('required test 1: alcohol + late_meal spanning Wed evening -> Thu morning produce ONE Wednesday-night episode', () => {
  const items = [
    { id: 'a1', concepts: ['alcohol'], label: 'drinks', timestamp: '2026-07-16T03:00:00Z' }, // 11pm Wed ET
    { id: 'a2', concepts: ['late_meal'], label: 'late dinner', timestamp: '2026-07-16T04:30:00Z' }, // 12:30am Thu ET
  ];
  const episodes = groupIntoEpisodes(items, TZ);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].nightOf, '2026-07-15'); // "Wednesday night"
});

test('required test 2: two concepts from one episode are not counted as two nights', () => {
  const items = [
    { id: 'a1', concepts: ['alcohol'], label: 'drinks', timestamp: '2026-07-16T03:00:00Z' },
    { id: 'a2', concepts: ['late_meal'], label: 'late dinner', timestamp: '2026-07-16T04:30:00Z' },
  ];
  const episodes = groupIntoEpisodes(items, TZ);
  assert.equal(episodes.length, 1);
  assert.deepEqual(episodes[0].concepts, ['alcohol', 'late_meal']); // one row, union of concepts
  const agg = buildAggregates(episodes);
  assert.equal(agg.combinedNights, 1);
  assert.equal(agg.alcoholNights, 1);
  assert.equal(agg.lateMealNights, 1);
});

test('required test 3: two genuinely separate nights produce two episodes', () => {
  const items = [
    { id: 'a1', concepts: ['alcohol'], label: 'drinks Wed', timestamp: '2026-07-16T03:00:00Z' }, // 11pm Wed
    { id: 'a2', concepts: ['alcohol'], label: 'drinks Fri', timestamp: '2026-07-18T03:00:00Z' }, // 11pm Fri
  ];
  const episodes = groupIntoEpisodes(items, TZ);
  assert.equal(episodes.length, 2);
  assert.deepEqual(episodes.map((e) => e.nightOf).sort(), ['2026-07-15', '2026-07-17']);
  assert.equal(buildAggregates(episodes).alcoholNights, 2);
});

test('groupIntoEpisodes: assertion + annotation items on the same night both contribute (source becomes "mixed")', () => {
  const items = [
    { id: 'assertion:1', concepts: ['alcohol'], timestamp: '2026-07-16T03:00:00Z', source: 'assertion' },
    { id: 'annotation:9', concepts: ['late_meal'], timestamp: '2026-07-16T04:00:00Z', source: 'annotation' },
  ];
  const episodes = groupIntoEpisodes(items, TZ);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].source, 'mixed');
  assert.deepEqual(episodes[0].assertionIds.sort(), ['annotation:9', 'assertion:1']);
});

test('groupIntoEpisodes: episodes are sorted chronologically by nightOf', () => {
  const items = [
    { id: 'a1', concepts: ['stress'], timestamp: '2026-07-18T03:00:00Z' },
    { id: 'a2', concepts: ['alcohol'], timestamp: '2026-07-15T03:00:00Z' },
  ];
  const episodes = groupIntoEpisodes(items, TZ);
  assert.deepEqual(episodes.map((e) => e.nightOf), ['2026-07-14', '2026-07-17']);
});

test('groupIntoEpisodes: ignores items with no timestamp rather than throwing', () => {
  const items = [{ id: 'a1', concepts: ['alcohol'], timestamp: null }];
  assert.deepEqual(groupIntoEpisodes(items, TZ), []);
});

// ── nightsWithBothConcepts / buildAggregates — general mechanism ────────

test('nightsWithBothConcepts works generically for any concept pair, not just alcohol/late_meal', () => {
  const episodes = [
    { nightOf: '2026-07-15', concepts: ['stress', 'hard_training'] },
    { nightOf: '2026-07-16', concepts: ['stress'] },
  ];
  assert.equal(nightsWithBothConcepts(episodes, 'stress', 'hard_training'), 1);
  assert.equal(nightsWithBothConcepts(episodes, 'stress', 'illness'), 0);
});

test('buildAggregates: supportedDates lists exactly the canonical episode dates', () => {
  const episodes = groupIntoEpisodes([
    { id: 'a1', concepts: ['alcohol'], timestamp: '2026-07-16T03:00:00Z' },
    { id: 'a2', concepts: ['alcohol'], timestamp: '2026-07-18T03:00:00Z' },
  ], TZ);
  assert.deepEqual(buildAggregates(episodes).supportedDates, ['2026-07-15', '2026-07-17']);
});

// ── isEligibleRawAnnotation — required test 4 (exclusions) ──────────────
// Retired/superseded rows never reach this function at all (excluded by
// annotationsStore.overlapping()'s own SQL before the ledger builder ever
// sees them) — this covers the content-based exclusions this function is
// actually responsible for: negated, retracted, planned (future), and
// financial annotations.

test('required test 4a: a retraction is not eligible for the ledger', () => {
  assert.equal(isEligibleRawAnnotation({ label: 'Please forget that context about drinks last night', category: 'life' }), false);
});

test('required test 4b: a plain negation ("didn\'t drink") is not eligible', () => {
  assert.equal(isEligibleRawAnnotation({ label: "Didn't end up drinking last night", category: 'life' }), false);
});

test('required test 4c: a future plan is not eligible (it hasn\'t happened)', () => {
  assert.equal(isEligibleRawAnnotation({ label: 'Drinks planned for tonight', category: 'life' }), false);
});

test('required test 4d: a financial annotation is not eligible for the event ledger', () => {
  assert.equal(isEligibleRawAnnotation({ label: 'Spent $85 on a big bar tab', category: 'other' }), false);
});

test('an OCCURRED event is eligible', () => {
  assert.equal(isEligibleRawAnnotation({ label: 'Had wine and a late dinner last night', category: 'life' }), true);
});

test('an ONGOING event (illness/travel) is eligible', () => {
  assert.equal(isEligibleRawAnnotation({ label: 'Still recovering from the flu', category: 'illness' }), true);
});

// ── required test 5: duplicate raw/compiled representations count once ──

test('required test 5: a raw annotation already covered by a compiled assertion is excluded (counts once)', () => {
  const assertions = [
    { id: 101, concepts: ['alcohol'], rawText: 'drinks last night', effectiveStart: '2026-07-16T03:00:00Z', sourceAnnotationId: 55 },
  ];
  const rawAnnotations = [
    { id: 55, label: 'drinks', category: 'life', start_ts: '2026-07-16T03:00:00Z' }, // same event, already compiled
    { id: 56, label: 'a late dinner too', category: 'life', start_ts: '2026-07-16T04:00:00Z' }, // NOT covered — genuinely new info
  ];
  const assertionItems = assertionsToItems(assertions);
  const covered = coveredAnnotationIdsFrom(assertionItems);
  assert.ok(covered.has(55));
  const uncovered = excludeCoveredAnnotations(rawAnnotations, covered);
  assert.deepEqual(uncovered.map((a) => a.id), [56]);

  const rawItems = rawAnnotationsToItems(uncovered);
  const episodes = groupIntoEpisodes([...assertionItems, ...rawItems], TZ);
  // ONE episode (same night), and the covered raw row (id 55) contributed
  // NOTHING beyond what the assertion already represents — no double count.
  assert.equal(episodes.length, 1);
  assert.equal(buildAggregates(episodes).alcoholNights, 1);
  assert.deepEqual(episodes[0].assertionIds.sort(), ['annotation:56', 'assertion:101']);
});

// ── required test 7: timezone / DST boundaries ───────────────────────────

test('required test 7a: episodeDateFor is correct across a spring-forward DST boundary (America/New_York)', () => {
  // DST began 2026-03-08 02:00 local -> 03:00 EDT. 1:30am local (still EST,
  // pre-jump) is early morning -> belongs to the PREVIOUS day's episode.
  assert.equal(episodeDateFor('2026-03-08T06:30:00Z', TZ), '2026-03-07');
  // 4:30am local (just after the jump, EDT) is still early morning -> same rule.
  assert.equal(episodeDateFor('2026-03-08T08:30:00Z', TZ), '2026-03-07');
});

test('required test 7b: episodeDateFor honors the device/app IANA timezone, not a fixed UTC offset', () => {
  // The same instant is early-morning in New York but still evening the
  // PRIOR day in Auckland (UTC+13 in Jan, DST) — different tz, different
  // episode date, from the identical timestamp.
  const instant = '2026-01-02T05:00:00Z'; // 12am Jan 2 in New York (EST, UTC-5); 6pm Jan 2 in Auckland (UTC+13)... verify below
  const nyDate = episodeDateFor(instant, 'America/New_York');
  const aucklandDate = episodeDateFor(instant, 'Pacific/Auckland');
  assert.equal(nyDate, '2026-01-01'); // 12am local -> early morning -> previous day's episode
  assert.notEqual(nyDate, aucklandDate); // proves tz is actually honored, not hardcoded
});
