// Single authoritative source for recovery score thresholds — both the
// canonical three-band value (green|yellow|red, which drives training logic,
// forecasting, validation, historical data, and every API) and the finer
// user-facing presentation tiers layered on top of it.
//
// The canonical band boundaries (63 / 40) are NEVER redefined here — the
// presentation tiers are a strict subdivision of the canonical yellow range
// (40-62) into "solid — near green" (55-62) and "moderate" (40-54). `ready`
// and `low` map exactly onto canonical green/red. This means a score's
// canonical band is always derivable from its presentation tier, and no
// consumer can accidentally move the green/red thresholds by only touching
// presentation.
//
// Every other module that needs the 63/40 cutoffs (recovery.js, predict.js)
// or a user-facing label/color (mobile health surfaces) MUST import from
// here rather than hardcoding the numbers — that duplication is exactly what
// let recovery.js's own doc comment go stale while the real thresholds moved.

const GREEN_MIN = 63;
const YELLOW_MIN = 40;

/** Canonical three-band value. Drives training logic (autoDowngradeFor),
 *  forecasting (predictCapacity/forecastTomorrow), validation, and every
 *  historical score. Never change what this returns without an explicit,
 *  separate decision to move the canonical threshold. */
function canonicalBand(score) {
  if (score == null || !Number.isFinite(score)) return null;
  if (score >= GREEN_MIN) return 'green';
  if (score >= YELLOW_MIN) return 'yellow';
  return 'red';
}

// Presentation tiers — additive, user-facing only. `min` boundaries for
// 'ready' and 'low' are identical to GREEN_MIN/YELLOW_MIN by construction.
const PRESENTATION_TIERS = Object.freeze([
  Object.freeze({ tier: 'ready', min: GREEN_MIN, label: 'Ready', color: 'green' }),
  Object.freeze({ tier: 'solid_near_green', min: 55, label: 'Solid — near green', color: 'warmGreen' }),
  Object.freeze({ tier: 'moderate', min: YELLOW_MIN, label: 'Moderate', color: 'amber' }),
  Object.freeze({ tier: 'low', min: 0, label: 'Low', color: 'red' }),
]);

/** The presentation tier descriptor for a score, or null without a score. */
function presentationTierFor(score) {
  if (score == null || !Number.isFinite(score)) return null;
  for (const t of PRESENTATION_TIERS) {
    if (score >= t.min) return t;
  }
  return PRESENTATION_TIERS[PRESENTATION_TIERS.length - 1];
}

module.exports = {
  GREEN_MIN,
  YELLOW_MIN,
  canonicalBand,
  PRESENTATION_TIERS,
  presentationTierFor,
};
