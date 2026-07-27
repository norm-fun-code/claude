// The unambiguous displayed-content-vs-attempt-state API contract (Chief
// Brief regression fix). `chiefBriefProvenance` describes WHAT is being
// shown (only present when chiefBrief is non-null); `chiefBriefAttempt`
// describes the health of the LATEST build/repair attempt, entirely
// independently — a failed/degraded attempt can report failure here while
// chiefBriefProvenance keeps pointing at the still-good displayed content.
// See routes/briefing.js's three response-construction call sites
// (cache-hit serve, full build, scoped rebuild) — all three compute this the
// same way through this one function so the contract can never drift.
'use strict';

/**
 * @param {object} opts
 * @param {object|null} opts.chiefBrief the FINAL content this response is displaying.
 * @param {'fresh'|'last_good'} opts.source how chiefBrief was obtained — a brand
 *   new fresh attempt, or carried forward from an earlier same-day build.
 * @param {string|null} opts.localDate the local day chiefBrief's content was built for.
 * @param {string|null} opts.builtAt when the DISPLAYED content was actually built
 *   (for last_good, this is the ORIGINAL build's time, not "now").
 * @param {string|null} opts.snapshotId the state-snapshot identity chiefBrief's
 *   content was derived from.
 * @param {'none'|'queued'|'building'|'fresh'|'degraded'|'failed'} opts.attemptState
 *   the outcome of the latest known build/repair ATTEMPT — independent of source.
 * @param {string|null} [opts.attemptedAt]
 * @param {string[]} [opts.reasonCodes]
 * @param {boolean} [opts.persistenceFailed] true when a FRESH attempt's own
 *   save to the briefings table failed (content is shown this response, but
 *   was never durably published).
 */
function buildChiefBriefContract({
  chiefBrief, source, localDate = null, builtAt = null, snapshotId = null,
  attemptState, attemptedAt = null, reasonCodes = [], persistenceFailed = false,
}) {
  return {
    chiefBriefProvenance: chiefBrief != null
      ? { source, localDate, builtAt, snapshotId }
      : null,
    chiefBriefAttempt: {
      state: attemptState,
      attemptedAt,
      reasonCodes: reasonCodes ?? [],
      persistenceFailed: Boolean(persistenceFailed),
    },
  };
}

/** Map an assessChiefBriefQuality() status (or its absence, for legacy rows)
 *  to the attempt-state enum. `hadChiefBrief` disambiguates a null-quality
 *  legacy row (treated as fresh, same backward-compat rule as
 *  notify/morning.js's hasPublishableFreshBriefToday) from one where nothing
 *  was ever attempted. */
function attemptStateFromQuality(qualityStatus, hadChiefBrief) {
  if (qualityStatus) return qualityStatus;
  return hadChiefBrief ? 'fresh' : 'none';
}

module.exports = { buildChiefBriefContract, attemptStateFromQuality };
