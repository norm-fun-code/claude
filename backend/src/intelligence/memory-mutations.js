// Memory mutations (product audit rec #6) — Correct/Forget/Mark-temporary
// for context_assertions. Deliberately thin: every mutation here goes
// through the SAME compiler/persistence/invalidation discipline every other
// context write already uses (intelligence/context-compiler.js's
// compileUserContext/persistCompiledContext, db.withTransaction,
// brain/invalidation's bumpDurable('context_assertion_change')) — this is
// not a second write pipeline, just the explicit-target entrypoint the
// Memory screen needs (the user already knows EXACTLY which card they're
// correcting/forgetting, unlike routes/annotations.js's POST
// /briefing/context or chat/executeAction.js's add_context, which only ever
// have raw text and must fuzzy-match what it corrects).
//
// Belief mutations (Confirm/Edit/Retire/Forget) need none of this — they
// already have a complete, correct implementation in store/beliefs.js +
// routes/beliefs.js (no BrainSnapshot authority reads beliefs live; only
// the nightly self-model does, so there is nothing to invalidate — see
// brain/registry.js, which has no beliefs entry). The Memory screen calls
// those existing endpoints directly for belief-origin items.
'use strict';

const contextAssertionsStore = require('../store/contextAssertions');
const { compileUserContext, persistCompiledContext } = require('./context-compiler');

/**
 * "Correct" — replace one specific assertion with newly-compiled structured
 * meaning. Always retires the EXACT assertion the user tapped, regardless of
 * whatever the compiler's own fuzzy-match supersession decides (belt-and-
 * suspenders: the UI already knows the precise target, so this doesn't rely
 * on text-overlap guessing the way a raw-text-only input path must).
 * Fails closed (no mutation at all) only when the compiler itself hard-fails
 * (LLM refusal/timeout/malformed output) — a correction that compiles into
 * zero NEW structured assertions still retires the original, since the
 * user's intent ("this is wrong") is clear even when the replacement text
 * doesn't structure further.
 */
async function correctAssertion({ assertionId, correctionText, tz = process.env.TZ || 'America/New_York', now = new Date() }) {
  const original = await contextAssertionsStore.getById(assertionId);
  if (!original) return { ok: false, error: 'not_found' };
  if (original.retiredAt) return { ok: false, error: 'already_retired' };

  const text = String(correctionText || '').trim();
  if (!text) return { ok: false, error: 'text_required' };

  const recentActiveAssertions = await contextAssertionsStore
    .getActive({ recordedFrom: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) })
    .catch(() => []);
  const compiled = await compileUserContext({
    rawText: text, source: 'memory_correction', tz, now, recentActiveAssertions,
  });
  if (compiled.failed) return { ok: false, error: 'context_compilation_failed', failureType: compiled.failureType };

  const { withTransaction } = require('../db');
  await withTransaction(async (client) => {
    const db = (queryText, params) => client.query(queryText, params);
    await contextAssertionsStore.retire(assertionId, 'corrected by user', db);
    if (compiled.assertions.length) {
      await persistCompiledContext(compiled, { sourceAnnotationId: null, db });
    }
  });

  // Always invalidate — the explicit retire above changes context_assertions
  // state even on the rare correction that produces zero new structured
  // assertions (unlike intelligence/context-input.js's recordUserContext,
  // whose invalidation is gated on compiled.assertions.length because ITS
  // callers have no unconditional mutation of their own to cover).
  await require('../brain/invalidation').bumpDurable('context_assertion_change');
  return { ok: true, newAssertionCount: compiled.assertions.length };
}

/** "Forget" — retire one assertion outright, no replacement. */
async function forgetAssertion({ assertionId }) {
  const ok = await contextAssertionsStore.retire(assertionId, 'forgotten by user');
  if (ok) await require('../brain/invalidation').bumpDurable('context_assertion_change');
  return ok;
}

/** "Mark temporary / set expiration" — bounds a currently-durable
 *  (preference-type) assertion with an explicit end. Scoped to durable
 *  assertions only by the route layer (see routes/memory.js) — an already-
 *  episodic assertion already has its own effective_end from compile time. */
async function setAssertionExpiration({ assertionId, effectiveEnd }) {
  const ok = await contextAssertionsStore.setEffectiveEnd(assertionId, effectiveEnd);
  if (ok) await require('../brain/invalidation').bumpDurable('context_assertion_change');
  return ok;
}

module.exports = { correctAssertion, forgetAssertion, setAssertionExpiration };
