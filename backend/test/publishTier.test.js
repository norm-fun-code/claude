// Required regression coverage for the authoritative 3-tier publishability
// contract (July 30 2026 incident hardening) — see brain/publishTier.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PUBLISH_TIER, derivePublishTier, isPublishableTier, tierRank, deterministicChiefBrief, tierForStoredContent } = require('../src/brain/publishTier');

test('required: a fresh quality result is premium_fresh', () => {
  assert.equal(derivePublishTier({ status: 'fresh', reasonCodes: [] }), PUBLISH_TIER.PREMIUM_FRESH);
});

test('required: a merely underfilled/thin degraded result is grounded_usable, not discarded', () => {
  assert.equal(
    derivePublishTier({ status: 'degraded', reasonCodes: ['synthesis_underfilled'] }),
    PUBLISH_TIER.GROUNDED_USABLE
  );
});

test('required: a grounded-fallback-sentence degraded result is grounded_usable', () => {
  assert.equal(
    derivePublishTier({ status: 'degraded', reasonCodes: ['grounded_fallback_used'] }),
    PUBLISH_TIER.GROUNDED_USABLE
  );
});

test('required: a degraded result with an unresolved factual claim violation is hard_failed — never published', () => {
  assert.equal(
    derivePublishTier({ status: 'degraded', reasonCodes: ['unresolved_claim_violation'] }),
    PUBLISH_TIER.HARD_FAILED
  );
});

test('required: a failed quality result (no chiefBrief / missing required field) is hard_failed', () => {
  assert.equal(derivePublishTier({ status: 'failed', reasonCodes: ['no_chief_brief'] }), PUBLISH_TIER.HARD_FAILED);
  assert.equal(derivePublishTier({ status: 'failed', reasonCodes: ['synthesis_missing'] }), PUBLISH_TIER.HARD_FAILED);
});

test('required: null/undefined quality is hard_failed, never throws', () => {
  assert.equal(derivePublishTier(null), PUBLISH_TIER.HARD_FAILED);
  assert.equal(derivePublishTier(undefined), PUBLISH_TIER.HARD_FAILED);
});

test('required: isPublishableTier is true for premium_fresh and grounded_usable only', () => {
  assert.equal(isPublishableTier(PUBLISH_TIER.PREMIUM_FRESH), true);
  assert.equal(isPublishableTier(PUBLISH_TIER.GROUNDED_USABLE), true);
  assert.equal(isPublishableTier(PUBLISH_TIER.HARD_FAILED), false);
  assert.equal(isPublishableTier(null), false);
});

test('required: tierRank orders premium_fresh > grounded_usable > hard_failed, never lets an unknown tier outrank a real publish', () => {
  assert.ok(tierRank(PUBLISH_TIER.PREMIUM_FRESH) > tierRank(PUBLISH_TIER.GROUNDED_USABLE));
  assert.ok(tierRank(PUBLISH_TIER.GROUNDED_USABLE) > tierRank(PUBLISH_TIER.HARD_FAILED));
  assert.equal(tierRank('not_a_real_tier'), tierRank(PUBLISH_TIER.HARD_FAILED));
});

test('required: deterministicChiefBrief assembles every required field from canonical facts alone, no LLM', () => {
  const facts = { recoveryBand: 'green', recoveryScore: 81, effectiveWorkoutLabel: 'Easy run' };
  const cb = deterministicChiefBrief(facts);
  assert.ok(cb);
  for (const field of ['synthesis', 'action', 'risk', 'move']) {
    assert.equal(typeof cb[field], 'string');
    assert.ok(cb[field].trim().length > 0, `${field} must not be blank`);
  }
  assert.match(cb.synthesis, /green/);
  assert.match(cb.action, /Easy run/);
});

test('required: deterministicChiefBrief never manufactures a risk that was not flagged', () => {
  const cb = deterministicChiefBrief({ recoveryBand: 'green' });
  assert.match(cb.risk, /No specific risk flagged/);
});

test('required: deterministicChiefBrief returns null (never fabricates) when there are no canonical facts at all', () => {
  assert.equal(deterministicChiefBrief(null), null);
  assert.equal(deterministicChiefBrief(undefined), null);
  assert.equal(deterministicChiefBrief('not an object'), null);
});

// tierForStoredContent — the backward-compatibility-aware sibling of
// derivePublishTier used for reading ALREADY-PERSISTED rows (never a fresh
// in-memory attempt). A real production gap this closes: a legacy row
// saved before the 3-tier contract existed (no chiefBriefQuality/publishTier
// at all) was being reclassified as hard_failed by derivePublishTier(null),
// which silently let a brand-new grounded_usable attempt outrank and
// overwrite it under the never-downgrade invariant.
test('required: tierForStoredContent treats a legacy row (real chiefBrief, no quality stamp at all) as premium_fresh, matching hasPublishableFreshBriefToday\'s convention', () => {
  assert.equal(tierForStoredContent({ chiefBrief: { synthesis: 's' } }), PUBLISH_TIER.PREMIUM_FRESH);
});

test('required: tierForStoredContent treats a truly empty row (no chiefBrief, no quality) as hard_failed', () => {
  assert.equal(tierForStoredContent({ chiefBrief: null }), PUBLISH_TIER.HARD_FAILED);
  assert.equal(tierForStoredContent(null), PUBLISH_TIER.HARD_FAILED);
});

test('required: tierForStoredContent prefers an explicit publishTier stamp, then falls back to deriving from chiefBriefQuality', () => {
  assert.equal(tierForStoredContent({ chiefBrief: { synthesis: 's' }, publishTier: 'grounded_usable', chiefBriefQuality: { status: 'fresh' } }), PUBLISH_TIER.GROUNDED_USABLE);
  assert.equal(tierForStoredContent({ chiefBrief: { synthesis: 's' }, chiefBriefQuality: { status: 'degraded', reasonCodes: ['unresolved_claim_violation'] } }), PUBLISH_TIER.HARD_FAILED);
});
