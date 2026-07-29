// Honest snapshot/field timestamps (requirement #7) + recovery-materiality
// (Bug 1). A scoped chief-brief rebuild must NOT make untouched cards look
// freshly derived: it advances builtAt (the "rebuild finished" poll signal) and
// re-stamps ONLY the fields it actually recut, leaving every other field's
// derivation time exactly where the last full build left it. And the cache-hit
// recovery refresh must only fire when recovery changed ENOUGH to move a derived
// field. Both helpers are pure — tested here directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const { stampFields, recoveryMateriallyChanged, FULL_BUILD_FIELDS, dateOnly } = require('../src/routes/briefing');

// ── stampFields: scoped rebuild only touches its own fields ──────────────────
test('a full build stamps every field at one snapshot time', () => {
  const t0 = '2026-06-11T11:00:00.000Z';
  const map = stampFields({}, FULL_BUILD_FIELDS, t0);
  for (const f of FULL_BUILD_FIELDS) assert.equal(map[f], t0);
});

test('a scoped chief-brief rebuild re-stamps ONLY chiefBrief + morningFocus, not the untouched cards', () => {
  const t0 = '2026-06-11T11:00:00.000Z'; // full build
  const t1 = '2026-06-11T15:30:00.000Z'; // later scoped rebuild
  const full = stampFields({}, FULL_BUILD_FIELDS, t0);

  const scoped = stampFields(full, ['chiefBrief', 'morningFocus'], t1);

  // The two fields the scoped rebuild actually recut advanced…
  assert.equal(scoped.chiefBrief, t1);
  assert.equal(scoped.morningFocus, t1);
  // …and every other field still shows its ORIGINAL full-build derivation time,
  // so a consumer can't be fooled into thinking recovery/workout/wealth/forecast
  // were re-derived just because the global builtAt moved.
  assert.equal(scoped.recovery, t0);
  assert.equal(scoped.todayForecast, t0);
  assert.equal(scoped.workout, t0);
  assert.equal(scoped.recoveryComposite, t0);
  assert.equal(scoped.wealth, t0);
});

test('stampFields never mutates the input map (returns a fresh object)', () => {
  const prev = { chiefBrief: 'a' };
  const next = stampFields(prev, ['chiefBrief'], 'b');
  assert.equal(prev.chiefBrief, 'a');
  assert.equal(next.chiefBrief, 'b');
  assert.notEqual(prev, next);
});

// ── recoveryMateriallyChanged: the cache-hit atomic-refresh trigger (Bug 1) ──
test('a band change is always material', () => {
  assert.equal(recoveryMateriallyChanged({ score: 66, band: 'yellow' }, { score: 64, band: 'red' }), true);
});

test('a small same-band score wobble is NOT material (avoids churn on every serve)', () => {
  assert.equal(recoveryMateriallyChanged({ score: 66, band: 'yellow' }, { score: 65, band: 'yellow' }), false);
});

test('a >=3 same-band score move IS material', () => {
  assert.equal(recoveryMateriallyChanged({ score: 66, band: 'yellow' }, { score: 62, band: 'yellow' }), true);
});

test('a present<->absent transition is material', () => {
  assert.equal(recoveryMateriallyChanged(null, { score: 55, band: 'yellow' }), true);
  assert.equal(recoveryMateriallyChanged({ score: 55, band: 'yellow' }, null), true);
});

test('a proxy<->real transition is material (it changes how the forecast tempers the grade)', () => {
  assert.equal(recoveryMateriallyChanged(
    { score: 60, band: 'yellow', proxy: true }, { score: 60, band: 'yellow', proxy: false }), true);
});

test('identical recovery is not material', () => {
  const r = { score: 60, band: 'yellow', proxy: false };
  assert.equal(recoveryMateriallyChanged(r, { ...r }), false);
});

// ── dateOnly: weekly-review CI fix — briefings.period_start is TIMESTAMPTZ,
// so pg hands back a JS Date; serializing it raw produces a full ISO
// timestamp instead of the plain YYYY-MM-DD every other weekStart producer
// (store/intentions.js's weekStart()) uses. Required regression for the
// exact CI failure: expected '2026-07-06', actual '2026-07-06T00:00:00.000Z'.
test('required: dateOnly formats a Date (as returned by pg for a TIMESTAMPTZ column) as plain YYYY-MM-DD', () => {
  assert.equal(dateOnly(new Date('2026-07-06T00:00:00.000Z')), '2026-07-06');
});

test('dateOnly accepts an ISO string or anything Date-parseable, not just a Date instance', () => {
  assert.equal(dateOnly('2026-07-06T00:00:00.000Z'), '2026-07-06');
  assert.equal(dateOnly('2026-07-06'), '2026-07-06');
});

test('dateOnly is null-safe — a review with no period_start must not throw', () => {
  assert.equal(dateOnly(null), null);
  assert.equal(dateOnly(undefined), null);
});
