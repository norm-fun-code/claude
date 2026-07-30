// The authoritative Chief Brief publishability contract (July 30 2026
// incident hardening). Separates four dimensions that the pre-existing
// fresh/degraded/failed status (see claimValidator.js's assessChiefBriefQuality)
// had conflated into one all-or-nothing publish/discard decision:
//
//   1. Factual safety      — does the prose contradict canonical facts?
//   2. Structural usability — is every required field present and non-blank?
//   3. Editorial quality    — is the prose full-length, non-placeholder prose?
//   4. Persistence/read-back — did the save+read-back actually verify?
//
// Before this module, ANY non-'fresh' quality result was discarded entirely
// (see notify/morning.js, routes/briefing.js's `thisAttemptFresh` gate) —
// collapsing a harmless word-count miss (dimension 3) into total product
// unavailability, exactly the July 30 incident: an automatic build's chief
// brief came back schema-valid, factually safe, but thin ('quality_degraded'
// in the retry ledger) — and NOTHING published, no push, no fallback.
//
// This module's contract:
//   premium_fresh   — clears every bar: factually safe, structurally
//                     complete, full editorial quality.
//   grounded_usable — factually safe and structurally complete, but the
//                     prose was underfilled and/or replaced by a
//                     deterministic grounded-fallback sentence. PUBLISHABLE.
//   hard_failed     — no trustworthy chiefBrief at all, a required field is
//                     missing, or a factual contradiction survived
//                     neutralization. NEVER publishable.
//
// Every publish gate in the codebase (notify/morning.js, routes/briefing.js,
// store/briefings.js, brain/chiefBriefContract.js) must derive its
// publish/discard decision from derivePublishTier() below — never
// independently re-check `quality.status === 'fresh'`.
'use strict';

const { REQUIRED_BRIEF_FIELDS, groundedFallbackSentence } = require('./claimValidator');

const PUBLISH_TIER = Object.freeze({
  PREMIUM_FRESH: 'premium_fresh',
  GROUNDED_USABLE: 'grounded_usable',
  HARD_FAILED: 'hard_failed',
});

/** Derive the authoritative 3-tier publishability contract from an
 *  already-computed chiefBrief quality result (assessChiefBriefQuality's
 *  return shape, or briefing-ai.js's synthetic FAILED_QUALITY object). Pure;
 *  never throws. */
function derivePublishTier(quality) {
  if (!quality || quality.status === 'failed') return PUBLISH_TIER.HARD_FAILED;
  if (quality.status === 'fresh') return PUBLISH_TIER.PREMIUM_FRESH;
  // status === 'degraded': a contradiction that survived neutralization is
  // still factually unsafe — never publishable regardless of how complete
  // or well-worded the surrounding prose is. Every OTHER degraded reason
  // (underfilled prose, a grounded-fallback sentence) is safe to publish,
  // just not premium.
  const stillUnsafe = Array.isArray(quality.reasonCodes) && quality.reasonCodes.includes('unresolved_claim_violation');
  return stillUnsafe ? PUBLISH_TIER.HARD_FAILED : PUBLISH_TIER.GROUNDED_USABLE;
}

/** Is this tier ever eligible for publication? (premium_fresh or grounded_usable) */
function isPublishableTier(tier) {
  return tier === PUBLISH_TIER.PREMIUM_FRESH || tier === PUBLISH_TIER.GROUNDED_USABLE;
}

/** Derive the tier of an already-PERSISTED briefing row's content — distinct
 *  from derivePublishTier(quality) above, which requires an explicit quality
 *  object and (correctly) treats its ABSENCE as hard_failed for a fresh
 *  in-memory generation attempt (no quality assessment ran = nothing to
 *  trust yet). A STORED row is different: rows saved before this
 *  three-tier contract existed (or ANY quality contract at all) carry no
 *  chiefBriefQuality/publishTier whatsoever, yet are perfectly good,
 *  already-vetted-by-the-old-pipeline content — the SAME backward-
 *  compatibility convention every other legacy-row reader in this codebase
 *  already uses (notify/morning.js's hasPublishableFreshBriefToday,
 *  brain/chiefBriefContract.js's attemptStateFromQuality: "no quality
 *  metadata + real content = treat as fresh"). Never derive a stored row's
 *  tier via derivePublishTier(content.chiefBriefQuality) directly — that
 *  silently reclassifies every pre-contract row as hard_failed, which both
 *  breaks reading old rows AND (via the never-downgrade invariant) lets a
 *  brand new grounded_usable attempt outrank and overwrite a legacy premium
 *  row that simply never got a quality stamp. */
function tierForStoredContent(content) {
  if (!content) return PUBLISH_TIER.HARD_FAILED;
  if (content.publishTier) return content.publishTier;
  if (content.chiefBriefQuality != null) return derivePublishTier(content.chiefBriefQuality);
  return content.chiefBrief != null ? PUBLISH_TIER.PREMIUM_FRESH : PUBLISH_TIER.HARD_FAILED;
}

const TIER_RANK = Object.freeze({
  [PUBLISH_TIER.PREMIUM_FRESH]: 2,
  [PUBLISH_TIER.GROUNDED_USABLE]: 1,
  [PUBLISH_TIER.HARD_FAILED]: 0,
});

/** Numeric rank for "never downgrade already-published content" comparisons
 *  — premium_fresh (2) > grounded_usable (1) > hard_failed (0). An unranked/
 *  unknown tier sorts as hard_failed (0), never silently outranking a real
 *  publish. */
function tierRank(tier) {
  return TIER_RANK[tier] ?? 0;
}

/** A fully deterministic chiefBrief object assembled ONLY from canonical,
 *  already-validated facts (brain/snapshot.js's canonicalFacts) — no LLM
 *  call, so it can never be wrong in the way generated prose can. Used when
 *  generation itself hard-fails (provider refusal, timeout, truncation,
 *  malformed JSON, or exhausted correction retries) so THAT failure mode
 *  degrades to a grounded_usable publish instead of total unavailability.
 *
 *  Deliberately reuses claimValidator.js's groundedFallbackSentence — the
 *  SAME primitive that already backstops a single blank field mid-pipeline —
 *  applied to every required field at once. Never invents a risk or fact the
 *  canonical snapshot doesn't support: `groundedFallbackSentence('risk', …)`
 *  states the honest absence of a flagged risk rather than manufacturing one.
 *
 *  Returns null when `facts` itself isn't available/trustworthy — the
 *  caller must then remain hard_failed rather than fabricate over missing
 *  canonical state (required test: "missing canonical state produces a hard
 *  failure rather than fabricated content"). */
function deterministicChiefBrief(facts) {
  if (!facts || typeof facts !== 'object') return null;
  const chiefBrief = {};
  for (const field of REQUIRED_BRIEF_FIELDS) {
    chiefBrief[field] = groundedFallbackSentence(field, facts);
  }
  chiefBrief.openQuestion = '';
  chiefBrief.affirmation = '';
  return chiefBrief;
}

module.exports = { PUBLISH_TIER, derivePublishTier, isPublishableTier, tierRank, deterministicChiefBrief, tierForStoredContent };
