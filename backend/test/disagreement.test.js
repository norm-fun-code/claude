// Disagreement engine — the silences are the feature.
//
// This is the one surface in NormOS designed to say something unwelcome, which
// makes its failure mode uniquely bad: fire too easily and it stops being
// candour and becomes an app that nags, which gets muted, which costs the
// product the one thing it was for. So almost every test below asserts that
// NOTHING is said — for a one-off, for a comeback, for weeks that were never
// reviewed, for a goal that's mostly being hit.
//
// The other half of the contract is that when it DOES speak, it is
// uncontestable: the user's own goal text, the user's own achieved/missed
// verdict, real week dates, and a question rather than a judgement.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDisagreement,
  flattenGoalStatements,
  groupByIntent,
  assessIntent,
} = require('../src/intelligence/disagreement');

/** Weekly intention rows, newest week first, exactly as store/intentions.js's
 *  recentIntentions returns them. */
function weeks(spec) {
  return spec.map(([weekStart, goals]) => ({
    weekStart,
    context: null,
    goals: goals.map(([text, achieved]) => ({ text, achieved })),
  }));
}

/** N weeks all stating the same goal with the given verdicts, newest first. */
function repeated(text, verdicts, start = '2026-09-06') {
  const d = new Date(`${start}T12:00:00Z`);
  return weeks(verdicts.map((v, i) => {
    const wk = new Date(d.getTime() - i * 7 * 864e5).toISOString().slice(0, 10);
    return [wk, [[text, v]]];
  }));
}

// --- when it must stay silent -------------------------------------------

test('says nothing about a goal set only once', () => {
  assert.equal(buildDisagreement(repeated('morning training', [false])), null);
});

test('says nothing about a goal set twice — a plan that changed is not a pattern', () => {
  assert.equal(buildDisagreement(repeated('morning training', [false, false])), null);
});

test('says nothing when the weeks were never reviewed', () => {
  // Six statements, no verdicts. Not doing your Sunday review is not a
  // confession, and counting it as one would be the single most unfair thing
  // this module could do.
  assert.equal(buildDisagreement(repeated('morning training', [null, null, null, null, null, null])), null);
});

test('an unreviewed week is excluded from the verdict, never counted as a miss', () => {
  const a = assessIntent(groupByIntent(flattenGoalStatements(
    repeated('morning training', [false, false, false, null, null])
  ))[0]);
  assert.equal(a.graded, 3, 'only graded weeks form the denominator');
  assert.equal(a.missed, 3);
  assert.equal(a.unreviewed, 2);
});

test('says nothing when the goal is mostly being hit', () => {
  assert.equal(buildDisagreement(repeated('morning training', [true, true, true, false])), null);
});

test('says nothing about a comeback, however bad the history', () => {
  // The most important silence. Recent weeks are hits, so the pattern has
  // broken — raising its history would be collecting on a debt already paid,
  // and is exactly what would make this surface feel punitive.
  const out = buildDisagreement(repeated('morning training', [true, true, false, false, false, false, false]));
  assert.equal(out, null);
});

test('a single recent hit is not yet a comeback', () => {
  // One good week after five bad ones is not the pattern breaking, and
  // treating it as such would make the surface trivially escapable.
  const out = buildDisagreement(repeated('morning training', [true, false, false, false, false, false]));
  assert.ok(out, 'one hit should not silence a six-week pattern');
});

test('says nothing when there is no history at all', () => {
  assert.equal(buildDisagreement([]), null);
  assert.equal(buildDisagreement(null), null);
});

// --- grouping the same intention worded differently ----------------------

test('the same intention worded differently is recognized as one goal', () => {
  const groups = groupByIntent(flattenGoalStatements(weeks([
    ['2026-09-06', [['morning training sessions', false]]],
    ['2026-08-30', [['training in the morning', false]]],
    ['2026-08-23', [['morning training', false]]],
  ])));
  assert.equal(groups.length, 1, `expected one group, got ${groups.map((g) => g.label).join(' | ')}`);
  assert.equal(groups[0].statements.length, 3);
});

test('genuinely different goals are never merged', () => {
  const groups = groupByIntent(flattenGoalStatements(weeks([
    ['2026-09-06', [['morning training', false], ['call mum every Sunday', false]]],
  ])));
  assert.equal(groups.length, 2);
});

test('a group is labelled with the most recent phrasing the user chose', () => {
  const groups = groupByIntent(flattenGoalStatements(weeks([
    ['2026-08-23', [['morning training', false]]],
    ['2026-09-06', [['morning training sessions', false]]],
  ])));
  assert.equal(groups[0].label, 'morning training sessions', 'the label must be wording they will recognise');
});

test('statements are ordered newest first regardless of input order', () => {
  const flat = flattenGoalStatements(weeks([
    ['2026-08-23', [['x', false]]],
    ['2026-09-06', [['x', false]]],
    ['2026-08-30', [['x', false]]],
  ]));
  assert.deepEqual(flat.map((s) => s.weekStart), ['2026-09-06', '2026-08-30', '2026-08-23']);
});

test('a blank or missing goal contributes nothing', () => {
  const flat = flattenGoalStatements(weeks([['2026-09-06', [['   ', false], ['real goal', false]]]]));
  assert.equal(flat.length, 1);
  assert.equal(flat[0].text, 'real goal');
});

// --- what it says when it does speak ------------------------------------

test('the confrontation is countable, dated, and checkable', () => {
  const out = buildDisagreement(repeated('morning training', [false, false, false, true, false, false]));
  assert.ok(out);
  assert.match(out.headline, /6 weeks running/);
  assert.match(out.detail, /missed 5 of the 6 weeks/);
  assert.equal(out.counts.statements, 6);
  assert.equal(out.counts.missed, 5);
  assert.equal(out.counts.achieved, 1);
  assert.equal(out.weeksStated.length, 6);
  assert.equal(out.weeksMissed.length, 5);
  for (const w of out.weeksMissed) assert.match(w, /^\d{4}-\d{2}-\d{2}$/, 'every week must be a real, checkable date');
});

test('it asks a question and offers real options — it never renders a verdict', () => {
  const out = buildDisagreement(repeated('morning training', [false, false, false, false]));
  assert.match(out.question, /\?$/);
  assert.match(out.question, /goal|plan/i);
  const ids = out.options.map((o) => o.id).sort();
  assert.deepEqual(ids, ['keep', 'retire', 'revise'], 'all three honest resolutions must be offered');
  // The wording must stay flat. Anything editorial on top of the counts reads
  // as contempt rather than candour, and this is the surface where that
  // matters most.
  const prose = `${out.headline} ${out.detail}`;
  assert.ok(!/fail|lazy|excuse|should have|again|still/i.test(prose), `editorial wording leaked in: "${prose}"`);
});

test('it states that the evidence is the user\'s own words and own grading', () => {
  const out = buildDisagreement(repeated('morning training', [false, false, false, false]));
  assert.equal(out.evidence.source, 'weekly_intentions');
  assert.match(out.evidence.basis, /your own/i);
});

test('only ONE disagreement is raised, and it is the most-repeated one', () => {
  // Three simultaneous confrontations is an intervention, not a nudge.
  const history = weeks([
    ['2026-09-06', [['morning training', false], ['read more', false], ['meal prep', false]]],
    ['2026-08-30', [['morning training', false], ['read more', false], ['meal prep', false]]],
    ['2026-08-23', [['morning training', false], ['read more', false]]],
    ['2026-08-16', [['morning training', false]]],
  ]);
  const out = buildDisagreement(history);
  assert.ok(out);
  assert.equal(out.label, 'morning training');
  assert.equal(out.counts.statements, 4);
});

test('the stable id is derived from the goal, so the same one is recognizable across days', () => {
  const a = buildDisagreement(repeated('morning training', [false, false, false, false]), { snapshotId: 'snap1' });
  const b = buildDisagreement(repeated('morning training', [false, false, false, false]), { snapshotId: 'snap1' });
  assert.equal(a.stableId, b.stableId);
  assert.match(a.stableId, /morning-training/);
});

// --- resolution: it must be answerable, but not permanently escapable -----

test('a resolved disagreement goes quiet', () => {
  const history = repeated('morning training', [false, false, false, false]);
  const raised = buildDisagreement(history);
  assert.ok(raised);
  const silenced = buildDisagreement(history, {
    resolvedContext: { [raised.resolutionKey]: { statements: 4 } },
  });
  assert.equal(silenced, null, 'answering it must stop it repeating weekly');
});

test('but it comes back once the goal has been set several more times', () => {
  // Otherwise one tap silences it forever and the whole surface is decorative.
  const history = repeated('morning training', [false, false, false, false, false, false, false]);
  const out = buildDisagreement(history, {
    resolvedContext: { [`disagreement:${['morning', 'training'].sort().join('-')}`]: { statements: 4 } },
  });
  assert.ok(out, 'three more statements since the resolution is genuinely new information');
  assert.equal(out.counts.statements, 7);
});

test('re-wording the goal does not reset a resolution the user already made', () => {
  // The escape hatch that would otherwise exist: rename "morning training" to
  // "training in the morning" and the suppression key changes.
  const a = buildDisagreement(repeated('morning training', [false, false, false, false]));
  const b = buildDisagreement(repeated('training in the morning', [false, false, false, false]));
  assert.equal(a.resolutionKey, b.resolutionKey, 'the durable key must survive re-phrasing');
});

test('an unreadable stored resolution does not buy silence', () => {
  const history = repeated('morning training', [false, false, false, false]);
  const key = buildDisagreement(history).resolutionKey;
  for (const bad of [{}, { statements: 'lots' }, { statements: null }]) {
    assert.ok(buildDisagreement(history, { resolvedContext: { [key]: bad } }),
      `a resolution recording ${JSON.stringify(bad)} cannot justify staying quiet`);
  }
});

// --- week keys come from Postgres as Date objects, not strings ------------

test('a Postgres date column is normalized, not stringified into nonsense', () => {
  // week_start is a `date`, which node-pg hands back as a JS Date at local
  // midnight. String(d).slice(0, 10) gives "Sun Sep 06" — which renders as
  // nonsense AND, because the newest-first ordering is a string compare, sorts
  // weeks by weekday name and silently breaks the comeback check.
  const { toDayKey } = require('../src/intelligence/disagreement');
  assert.equal(toDayKey(new Date(2026, 8, 6)), '2026-09-06');
  assert.equal(toDayKey('2026-09-06'), '2026-09-06');
  assert.equal(toDayKey('2026-09-06T00:00:00.000Z'), '2026-09-06');
  assert.equal(toDayKey('Sun Sep 06 2026'), null, 'an unparseable key is dropped, never guessed at');
  assert.equal(toDayKey(null), null);
});

test('ordering and the comeback check survive Date-typed week keys', () => {
  // The end-to-end consequence: fed real Date objects, the two most recent
  // weeks are hits, so this is a comeback and must stay silent. With the
  // weekday-name sort it would order wrongly and confront the user instead.
  const d = (y, m, day) => new Date(y, m - 1, day);
  const history = [
    { weekStart: d(2026, 9, 6), goals: [{ text: 'morning training', achieved: true }] },
    { weekStart: d(2026, 8, 30), goals: [{ text: 'morning training', achieved: true }] },
    { weekStart: d(2026, 8, 23), goals: [{ text: 'morning training', achieved: false }] },
    { weekStart: d(2026, 8, 16), goals: [{ text: 'morning training', achieved: false }] },
    { weekStart: d(2026, 8, 9), goals: [{ text: 'morning training', achieved: false }] },
    { weekStart: d(2026, 8, 2), goals: [{ text: 'morning training', achieved: false }] },
  ];
  assert.equal(buildDisagreement(history), null, 'two recent hits is a comeback — stay silent');

  const flat = flattenGoalStatements(history);
  assert.deepEqual(flat.map((s) => s.weekStart).slice(0, 3), ['2026-09-06', '2026-08-30', '2026-08-23']);
});

test('a resolution stored in a Map silences it, exactly as a plain object does', () => {
  // dismissedContextByKey() returns a Map, and bracket access on a Map yields
  // undefined without throwing — so this mismatch fails silently, leaving the
  // card to reappear the instant it is answered.
  const history = repeated('morning training', [false, false, false, false]);
  const key = buildDisagreement(history).resolutionKey;
  const asMap = new Map([[key, { statements: 4 }]]);
  assert.equal(buildDisagreement(history, { resolvedContext: asMap }), null);
});
