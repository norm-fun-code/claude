// Bug: the chief brief said "Valuation presentation to Steffan is done" while
// its weekly_intentions.goals[].achieved checkbox was still false — the model
// inferred completion from something other than the checkbox (a calendar
// event, a prior brief, similar wording). weekly_intentions.goals[].achieved
// must be the SOLE authority for completion language anywhere in the brief.
//
// Two layers under test:
//  1. findFalseGoalCompletions / rewriteFalseGoalCompletions — the pure
//     detector + deterministic-repair functions.
//  2. generateChiefBrief's end-to-end retry/rewrite flow — proves a
//     shape-valid-but-semantically-wrong LLM response never ships as-is, and
//     a failed correction retry still returns a USABLE (rewritten) result
//     rather than null (which would force the caller to reuse a stale/
//     contaminated prior brief).
const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/llm');
const {
  generateChiefBrief, findFalseGoalCompletions, rewriteFalseGoalCompletions,
} = require('../src/services/briefing-ai');

const OPEN_GOAL = { text: 'Valuation presentation to Steffan', achieved: false };
const DONE_GOAL = { text: 'Finish the Q3 board deck', achieved: true };

// ── Pure detector/repair functions ──────────────────────────────────────────

test('findFalseGoalCompletions: an OPEN goal described as "is done" is flagged', () => {
  const v = findFalseGoalCompletions(
    { chiefBrief: { synthesis: 'Valuation presentation to Steffan is done.', action: 'a', risk: 'r', move: 'm' } },
    [OPEN_GOAL]
  );
  assert.equal(v.length, 1);
  assert.equal(v[0].field, 'synthesis');
  assert.equal(v[0].goalText, OPEN_GOAL.text);
});

test('findFalseGoalCompletions: a loose paraphrase is still caught (not just the exact title)', () => {
  const v = findFalseGoalCompletions(
    { chiefBrief: { synthesis: 'x', action: 'The valuation presentation is finished, nice work.', risk: 'r', move: 'm' } },
    [OPEN_GOAL]
  );
  assert.equal(v.length, 1, 'paraphrased completion language must still be caught');
  assert.equal(v[0].field, 'action');
});

test('findFalseGoalCompletions: the SAME goal with achieved:true is never flagged', () => {
  const v = findFalseGoalCompletions(
    { chiefBrief: { synthesis: 'Finished the Q3 board deck — it is done.', action: 'a', risk: 'r', move: 'm' } },
    [DONE_GOAL]
  );
  assert.equal(v.length, 0, 'an achieved goal may be freely described as done');
});

test('findFalseGoalCompletions: unrelated use of "done" does not false-positive', () => {
  const v = findFalseGoalCompletions(
    { chiefBrief: { synthesis: 'Your cold-shower streak is done for the week — nice consistency.', action: 'a', risk: 'r', move: 'm' } },
    [OPEN_GOAL]
  );
  assert.equal(v.length, 0, 'a completion verb with no overlap to the goal text must not trigger');
});

test('findFalseGoalCompletions: checks morningFocus too, not just chiefBrief fields', () => {
  const v = findFalseGoalCompletions(
    { chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm' }, morningFocus: 'The valuation presentation to Steffan is closed out.' },
    [OPEN_GOAL]
  );
  assert.equal(v.length, 1);
  assert.equal(v[0].field, 'morningFocus');
});

test('findFalseGoalCompletions: no open goals → nothing to check, always clean', () => {
  const v = findFalseGoalCompletions(
    { chiefBrief: { synthesis: 'Valuation presentation to Steffan is done.', action: 'a', risk: 'r', move: 'm' } },
    []
  );
  assert.equal(v.length, 0);
});

test('rewriteFalseGoalCompletions: replaces only the offending sentence, keeps the rest, never leaves a field empty', () => {
  const result = {
    chiefBrief: {
      synthesis: 'Valuation presentation to Steffan is done. Recovery is green today.',
      action: 'a', risk: 'r', move: 'm', openQuestion: '', affirmation: '',
    },
    morningFocus: 'mf',
  };
  const violations = findFalseGoalCompletions(result, [OPEN_GOAL]);
  const fixed = rewriteFalseGoalCompletions(result, violations);
  assert.doesNotMatch(fixed.chiefBrief.synthesis, /is done/);
  assert.match(fixed.chiefBrief.synthesis, /Valuation presentation to Steffan is still open\./);
  assert.match(fixed.chiefBrief.synthesis, /Recovery is green today\./, 'unrelated sentence in the same field is preserved');
  assert.ok(fixed.chiefBrief.synthesis.trim().length > 0, 'field must never end up empty');
  // Re-checking the rewritten result must now be clean.
  assert.equal(findFalseGoalCompletions(fixed, [OPEN_GOAL]).length, 0);
});

// ── End-to-end generateChiefBrief flow (LLM stubbed) ────────────────────────

const VALID_SHAPE = { openQuestion: '' };
function chiefJson(overrides) {
  return JSON.stringify({
    chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm', ...VALID_SHAPE, ...overrides },
    morningFocus: overrides.morningFocus ?? 'mf',
    urgentEmails: [],
  });
}

// The chief-brief call requests returnMeta:true (safe-to-log metadata
// alongside the text — see briefing-ai.js), so the stub must return
// {text, stopReason, requestId, model}, not a bare string.
function chiefMeta(text) {
  return { text, stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8' };
}

test('generateChiefBrief: a false "is done" claim about an OPEN goal never ships — the retry/rewrite corrects it', async () => {
  let call = 0;
  llm.generateText = async () => {
    call += 1;
    // Every attempt (including the correction retry) keeps making the same
    // mistake — proves the deterministic rewrite backstop actually engages.
    return chiefMeta(chiefJson({ synthesis: 'Valuation presentation to Steffan is done.' }));
  };
  const result = await generateChiefBrief(
    [], 'Tuesday', { type: 'Rest' }, [], '', '', '', '', '', '', [], '', '', '', '', '', '', '', '', '', [OPEN_GOAL]
  );
  assert.ok(result.chiefBrief, 'a usable chiefBrief must still be returned');
  assert.doesNotMatch(result.chiefBrief.synthesis, /is done/i);
  assert.equal(findFalseGoalCompletions(result, [OPEN_GOAL]).length, 0, 'the shipped result must be clean');
  assert.ok(call >= 2, 'the correction retry must actually have been attempted');
});

test('generateChiefBrief: a paraphrased false-completion claim triggers the same correction path', async () => {
  llm.generateText = async () => chiefMeta(chiefJson({ action: 'The valuation presentation is finished — great work.' }));
  const result = await generateChiefBrief(
    [], 'Tuesday', { type: 'Rest' }, [], '', '', '', '', '', '', [], '', '', '', '', '', '', '', '', '', [OPEN_GOAL]
  );
  assert.equal(findFalseGoalCompletions(result, [OPEN_GOAL]).length, 0);
});

test('generateChiefBrief: the SAME goal with achieved:true allows completion language through untouched', async () => {
  llm.generateText = async () => chiefMeta(chiefJson({ synthesis: 'Nice work — the Q3 board deck is done.' }));
  const result = await generateChiefBrief(
    [], 'Tuesday', { type: 'Rest' }, [], '', '', '', '', '', '', [], '', '', '', '', '', '', '', '', '', [DONE_GOAL]
  );
  assert.match(result.chiefBrief.synthesis, /Q3 board deck is done/);
});

test('generateChiefBrief: unrelated use of "done" ships unchanged (no false-positive rewrite)', async () => {
  llm.generateText = async () => chiefMeta(chiefJson({ synthesis: 'Your cold-shower streak is done for the week.' }));
  const result = await generateChiefBrief(
    [], 'Tuesday', { type: 'Rest' }, [], '', '', '', '', '', '', [], '', '', '', '', '', '', '', '', '', [OPEN_GOAL]
  );
  assert.match(result.chiefBrief.synthesis, /cold-shower streak is done/);
});

test('generateChiefBrief: a failed correction retry (bad shape) still returns a usable result, never EMPTY_CHIEF', async () => {
  let call = 0;
  llm.generateText = async () => {
    call += 1;
    if (call <= 2) return chiefMeta(chiefJson({ synthesis: 'Valuation presentation to Steffan is done.' }));
    // The correction retry (3rd call) comes back malformed — no chiefBrief at all.
    return chiefMeta(JSON.stringify({ notChiefBrief: true }));
  };
  const result = await generateChiefBrief(
    [], 'Tuesday', { type: 'Rest' }, [], '', '', '', '', '', '', [], '', '', '', '', '', '', '', '', '', [OPEN_GOAL]
  );
  assert.ok(result.chiefBrief, 'must not fall back to null/EMPTY_CHIEF — that would force the caller to reuse a stale prior brief');
  assert.doesNotMatch(result.chiefBrief.synthesis, /is done/i);
});
