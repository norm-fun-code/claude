// Production incident (Aug 5-6 2026): the automatic scoped Chief Brief
// repairs (goals_stale / plan_conflict) ran a full LLM rebuild INLINE on the
// cache-hit serve, and eligibleForRepair() exempted successful attempts from
// the cooldown entirely (`if (!prior || prior.succeeded) return true`). A
// repair can "succeed" — it produced a valid brief — without the triggering
// condition clearing, so the very next request re-evaluated the condition,
// asked the ledger, was told "last one succeeded, go ahead", and fired
// another full rebuild. Observed as 7 rebuilds in 3 minutes while the user
// sat on a loading card, each one slow enough to blow the mobile client's
// fetch deadline so no brief ever rendered.
//
// These pin the cooldown contract itself via the pure isEligible() decision
// (no DB) — eligibleForRepair() is just that function fed by a ledger read.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { isEligible } = require('../src/store/chiefBriefRepairLedger');

const MINUTE = 60 * 1000;
const COOLDOWN = 10 * MINUTE;

test('required: a repair that JUST SUCCEEDED is not immediately eligible again — the exact loop that fired 7 rebuilds in 3 minutes', () => {
  const prior = {
    repair_reason: 'plan_conflict',
    succeeded: true,
    context_key: null,
    attempted_at: new Date(Date.now() - 5 * 1000).toISOString(), // 5s ago
  };
  const eligible = isEligible({ prior, cooldownMs: COOLDOWN });
  assert.equal(eligible, false, 'a success 5 seconds ago must NOT re-authorize another full LLM rebuild');
});

test('required: a successful repair becomes eligible again only after the cooldown elapses', () => {
  const prior = {
    repair_reason: 'plan_conflict',
    succeeded: true,
    context_key: null,
    attempted_at: new Date(Date.now() - 11 * MINUTE).toISOString(),
  };
  const eligible = isEligible({ prior, cooldownMs: COOLDOWN });
  assert.equal(eligible, true, 'past the cooldown a genuinely-still-broken condition may be retried');
});

test('required: a FAILED repair is still cooldown-gated (unchanged behavior)', () => {
  const prior = {
    repair_reason: 'plan_conflict',
    succeeded: false,
    context_key: null,
    attempted_at: new Date(Date.now() - 5 * 1000).toISOString(),
  };
  assert.equal(isEligible({ prior, cooldownMs: COOLDOWN }), false);
});

test('required: no prior attempt at all is always eligible', () => {
  assert.equal(isEligible({ prior: null, cooldownMs: COOLDOWN }), true);
});

test('required: a NEW contextKey (e.g. the week rolled over) bypasses the cooldown even right after a success', () => {
  const prior = {
    repair_reason: 'goals_stale',
    succeeded: true,
    context_key: '2026-07-26',
    attempted_at: new Date(Date.now() - 5 * 1000).toISOString(),
  };
  const eligible = isEligible({
    prior,
    contextKey: '2026-08-02', // different week — a genuinely different problem
    cooldownMs: COOLDOWN,
  });
  assert.equal(eligible, true, 'a different context is a different problem, not a retry of the same one');
});

test('required: the SAME contextKey right after a success stays blocked', () => {
  const prior = {
    repair_reason: 'goals_stale',
    succeeded: true,
    context_key: '2026-08-02',
    attempted_at: new Date(Date.now() - 5 * 1000).toISOString(),
  };
  const eligible = isEligible({ prior, contextKey: '2026-08-02', cooldownMs: COOLDOWN });
  assert.equal(eligible, false, 'same week + just repaired = the loop this fix closes');
});
