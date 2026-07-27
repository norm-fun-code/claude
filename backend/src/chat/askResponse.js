// The structured AskResponse contract — the ONE shape every Ask/voice caller
// (routes/chat.js, routes/voice.js, chat/realtimeTools.js's deep_ask) builds
// its client-facing response from. This module does not compute any NEW
// fact: it is a thin, pure projection of what ask() already computed —
// brain/evidenceClaim.js's EvidenceClaim packet for `evidence`/`uncertainties`,
// chat/ask.js's validateAction output for `proposedActions`, and a cheap
// heuristic intent classifier — onto the fields the mobile Ask UI renders
// (direct answer, evidence with source/period/confidence, an action preview
// before any mutation, follow-ups). Building this here (rather than letting
// each route hand-assemble an ad hoc response) is what stops the three
// routes from drifting into three different ideas of what "the answer"
// contains.
'use strict';

const crypto = require('crypto');
const { isClaimStale } = require('../brain/evidenceClaim');
const { needsConfirmation, describeAction, reversibilityOf } = require('./actionPolicy');

// A question is DECIDE when it's asking for a recommendation/tradeoff, not a
// bare fact. Deliberately conservative (like ask.js's own looksLikeCommand):
// anything that doesn't match stays UNDERSTAND, the safer default for a
// factual/explanatory question. ACT is decided upstream from whether this
// turn is a command or produced any validated action — never from wording
// alone, since "should I swap my workout?" (a question) must NOT be treated
// as an act request the way "swap my workout" (a command) is.
const DECIDE_RE = /\b(should i|should we|could i|would it|which (one|is|should)|what'?s better|compare|recommend|worth it|is it (better|worth)|trade[- ]?offs?|pros and cons|better to do|instead of|what should i (do|focus|prioriti[sz]e))\b/i;

/** Understand (factual/explanatory) | Decide (tradeoff/recommendation) | Act
 *  (a mutation request or statement). No new LLM call — derived entirely
 *  from signals ask() already computes (looksLikeCommand, whether any
 *  action was validated) plus one conservative regex over the question
 *  text, per the task's explicit "don't add a call just to classify intent
 *  if the existing structured call can do it reliably" constraint. */
function classifyIntent(question, { isCommand = false, hasActions = false } = {}) {
  if (isCommand || hasActions) return 'act';
  if (DECIDE_RE.test(question || '')) return 'decide';
  return 'understand';
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'my', 'me', 'i', 'to', 'of', 'and', 'or',
  'for', 'on', 'in', 'at', 'it', 'that', 'this', 'what', 'why', 'how', 'do', 'does', 'did', 'should',
  'would', 'could', 'will', 'with', 'about', 'today', 'right', 'now', 'have', 'has', 'am', 'im', "i'm",
]);

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function keywordSet(text) {
  return new Set(tokenize(text).filter((t) => t.length > 2 && !STOPWORDS.has(t)));
}

/** A human-readable {statement, displayValue} for one EvidenceClaim — pure
 *  formatting over the canonical value already on the claim, keyed by the
 *  claim's `subject` prefix (see brain/evidenceClaim.js's buildEvidenceClaims
 *  for the exact subjects this must stay in sync with). Never computes a new
 *  fact, only phrases the one the claim already carries. */
function describeClaim(claim) {
  const { subject, predicate, value } = claim;
  if (subject === 'recovery') {
    if (predicate === 'band') return { statement: `Recovery band: ${value}`, displayValue: String(value) };
    if (predicate === 'score') return { statement: `Recovery score: ${value}`, displayValue: String(value) };
    if (predicate === 'contributingFactor') return { statement: `Associated with today's recovery: ${value}`, displayValue: String(value) };
    if (predicate === 'cause') return { statement: "No confirmed driver identified for today's recovery", displayValue: null };
  }
  if (subject === 'workout') {
    if (predicate === 'effectivePlan') {
      return { statement: `Today's effective workout: ${value?.label ?? 'unknown'} (source: ${value?.source ?? 'scheduled'})`, displayValue: value?.label ?? null };
    }
    if (predicate === 'completed') {
      return { statement: `Today's planned workout ${value ? 'was completed' : 'has not been completed'}`, displayValue: value };
    }
  }
  if (subject.startsWith('goal:')) {
    return { statement: `Goal "${subject.slice(5)}": ${value ? 'completed' : 'not yet completed'}`, displayValue: value };
  }
  if (subject.startsWith('commitment:')) {
    return { statement: `Commitment "${subject.slice(11)}": ${value ? 'completed' : 'still open'}`, displayValue: value };
  }
  if (subject === 'wealth' && predicate === 'spendingMonthToDate') {
    return { statement: `Spending month-to-date: $${value}`, displayValue: `$${value}` };
  }
  if (subject === 'forecast') {
    if (predicate === 'todayGrade') return { statement: `Today's forecast grade: ${value}`, displayValue: value };
    if (predicate === 'tomorrowBand') return { statement: `Tomorrow's forecast band: ${value}`, displayValue: value };
  }
  if (subject === 'calendar' && predicate === 'localDate') {
    return { statement: `Today's date: ${value}`, displayValue: value };
  }
  if (subject.startsWith('experiment:')) {
    return { statement: `Experiment "${subject.slice(11)}": ${value ?? 'running, not yet decided'}`, displayValue: value };
  }
  if (subject.startsWith('assertion:')) {
    return { statement: `${predicate}: ${value}`, displayValue: value };
  }
  if (subject.startsWith('weeklyEvent:')) {
    return { statement: `${subject.slice(12)}: ${Array.isArray(value) ? value.join(', ') : value}`, displayValue: value };
  }
  if (subject.startsWith('nightlyContext:')) {
    return { statement: `${subject.slice(15)} occurred`, displayValue: value };
  }
  return { statement: `${subject} ${predicate}: ${JSON.stringify(value)}`, displayValue: value };
}

/** Which of `claims` are actually relevant to THIS question/answer, ranked —
 *  never "dump every retrieved metric" (explicit task requirement). Pure
 *  keyword-overlap scoring against the claim's own subject/predicate/
 *  statement text; a claim that shares no vocabulary with the question or
 *  the generated answer is almost certainly not what grounded this specific
 *  reply, even if it was available in context. */
function selectRelevantEvidence(claims, { question = '', answer = '', limit = 6 } = {}) {
  if (!Array.isArray(claims) || !claims.length) return [];
  const qWords = keywordSet(question);
  const aWords = keywordSet(answer);
  const scored = claims.map((claim) => {
    const { statement } = describeClaim(claim);
    const claimWords = keywordSet(`${claim.subject} ${claim.predicate} ${statement}`);
    let score = 0;
    for (const w of claimWords) {
      if (qWords.has(w)) score += 2;
      if (aWords.has(w)) score += 1;
    }
    // A grounding-priority nudge for direct canonical facts over associations
    // — but ONLY as a tiebreaker among claims that already share real
    // vocabulary with the question/answer. Applying it unconditionally would
    // let every FACT claim in the packet sneak into evidence[] with zero
    // actual relevance, exactly the "dump every retrieved metric" behavior
    // this function exists to prevent.
    if (score > 0 && claim.claimType === 'fact') score += 0.5;
    return { claim, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.claim);
}

/** One EvidenceClaim -> the AskResponse evidence[] item shape. */
function claimToEvidence(claim, { asOf = new Date() } = {}) {
  const { statement, displayValue } = describeClaim(claim);
  return {
    factId: claim.claimId,
    statement,
    value: claim.value,
    displayValue,
    source: claim.evidenceRefs?.[0] ?? null,
    period: (claim.observedFrom || claim.observedTo) ? { from: claim.observedFrom, to: claim.observedTo } : null,
    asOf: claim.observedTo || claim.observedFrom || null,
    freshness: isClaimStale(claim, asOf) ? 'stale' : 'fresh',
    evidenceTier: claim.evidenceTier,
    confidence: claim.confidence,
  };
}

function humanizeCheck(check) {
  return String(check || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
}

/** Honest "here's what NormOS is NOT sure about" list — from UNKNOWN-type
 *  claims relevant to this question (an explicit "no established cause"
 *  fact, never silence) plus any claim-validator check that fired and
 *  neutralized part of the answer (debugEvidence — see chat/ask.js). */
function buildUncertainties(relevantClaims, debugEvidence) {
  const out = [];
  for (const claim of relevantClaims || []) {
    if (claim.claimType !== 'unknown') continue;
    if (claim.subject === 'recovery' && claim.predicate === 'cause') {
      out.push("NormOS doesn't have a confirmed driver for today's recovery — it can name contributing patterns, but not a proven cause.");
    } else {
      out.push(`NormOS doesn't have confirmed evidence for ${claim.subject}.`);
    }
  }
  for (const check of debugEvidence || []) {
    out.push(`NormOS held back part of its answer because it didn't match confirmed data (${humanizeCheck(check)}).`);
  }
  return out;
}

/** validated action objects (chat/ask.js's validateAction shape) + their
 *  per-turn execution outcome -> the AskResponse proposedActions[] shape. */
function buildProposedActions(actionResults) {
  return (actionResults || []).map(({ action, executed, result }) => {
    const { title, preview } = describeAction(action);
    return {
      actionType: action.action,
      title,
      preview,
      validatedPayload: action,
      requiresConfirmation: needsConfirmation(action),
      reversibility: reversibilityOf(action),
      executed: !!executed,
      executionResult: result ?? null,
    };
  });
}

/**
 * Assemble the full AskResponse for one turn. Nothing here computes a new
 * fact or makes a new retrieval/LLM call — every field is a formatting/
 * selection pass over what the caller (routes/chat.js, routes/voice.js,
 * chat/realtimeTools.js's deep_ask) already has from ask()'s result and its
 * own action-execution loop.
 *
 * @param {object} opts
 * @param {string} opts.question
 * @param {string} opts.answer - the (already claim-validated) answer text.
 * @param {string|null} [opts.reasoningSummary]
 * @param {Array} [opts.actionResults] - [{action, executed, result}].
 * @param {Array} [opts.claims] - ask()'s factsForValidation.claims.
 * @param {number|string|null} [opts.conversationId]
 * @param {string|null} [opts.snapshotId]
 * @param {number|null} [opts.snapshotVersion]
 * @param {string|null} [opts.snapshotAt]
 * @param {boolean} [opts.isCommand]
 * @param {string[]} [opts.debugEvidence]
 * @param {string[]} [opts.followUps]
 */
function buildAskResponse({
  question,
  answer,
  reasoningSummary = null,
  actionResults = [],
  claims = [],
  conversationId = null,
  snapshotId = null,
  snapshotVersion = null,
  snapshotAt = null,
  isCommand = false,
  debugEvidence = [],
  followUps = [],
} = {}) {
  const hasActions = Array.isArray(actionResults) && actionResults.length > 0;
  const intent = classifyIntent(question, { isCommand, hasActions });
  const relevantClaims = selectRelevantEvidence(claims, { question, answer });
  const evidence = relevantClaims.filter((c) => c.claimType !== 'unknown').map((c) => claimToEvidence(c));
  const uncertainties = buildUncertainties(relevantClaims, debugEvidence);
  const proposedActions = buildProposedActions(actionResults);

  return {
    responseId: `ar_${crypto.randomUUID()}`,
    conversationId,
    snapshotId,
    snapshotVersion,
    snapshotAt,
    intent,
    directAnswer: answer,
    reasoningSummary,
    evidence,
    uncertainties,
    proposedActions,
    followUps,
    generatedAt: new Date().toISOString(),
  };
}

/** A cheap, honest snapshotId/snapshotVersion for an Ask turn, without
 *  building a full BrainSnapshot (ask() deliberately does its own lean,
 *  parallel fetches rather than brain/snapshot.js's buildBrainSnapshot() —
 *  see chat/ask.js's retrieval comment — and this must not regress that).
 *  brain/invalidation.js's in-memory global version already bumps whenever
 *  ANY tracked field changes (Transactional Brain Invalidation), so it's a
 *  correct, zero-extra-query proxy for "which state was this answer built
 *  against." */
function currentSnapshotMeta() {
  try {
    const invalidation = require('../brain/invalidation');
    const v = invalidation.stateVersion();
    return { snapshotId: `ask:${v}`, snapshotVersion: v, snapshotAt: new Date().toISOString() };
  } catch {
    return { snapshotId: null, snapshotVersion: null, snapshotAt: null };
  }
}

module.exports = {
  classifyIntent,
  describeClaim,
  selectRelevantEvidence,
  claimToEvidence,
  buildUncertainties,
  buildProposedActions,
  buildAskResponse,
  currentSnapshotMeta,
};
