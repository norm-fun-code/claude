// Centralized recovery PRESENTATION semantics — the single place every
// surface (Health card/history, Today forecast, workout pill, Chief Brief,
// Ask, realtime voice, notifications) gets its user-facing recovery label,
// color, and guidance from. This is additive on top of the canonical
// score/band (recoveryThresholds.js, recovery.js's recoveryBand) — it never
// changes what band a score belongs to, only how a near-green score READS.
//
// The problem this fixes: a score of 59 is canonically 'yellow' (correctly —
// training logic, forecasting, and history all still treat it that way), but
// visually and verbally it was being presented exactly like a 40, implying
// under-recovery it doesn't have. presentationTierFor() (recoveryThresholds.js)
// splits the yellow range into "solid — near green" (55-62) and "moderate"
// (40-54) so a near-green day reads as reassuring, not alarming.
const { canonicalBand, presentationTierFor } = require('./recoveryThresholds');

// Base guidance per presentation tier, independent of any risk flag. This is
// the ONLY guidance a bare score may produce — deliberately never mentions
// "dial back", "under-recovered", or "keep it easy" for the near-green tier.
const BASE_GUIDANCE = Object.freeze({
  ready: "Ready — your body's ready. Full intensity is appropriate today.",
  solid_near_green: 'Solid readiness. Train as planned if you feel good; no automatic need to scale back.',
  moderate: 'Moderate — solid foundation. Push if you feel good, but watch your exertion.',
  low: "Low — under-recovered. Keep it easy today: mobility or a walk, and protect tonight's sleep.",
});

// Canonical display headline/prescription for the near-green tier —
// predict.js's Today forecast consumes THESE for a solid_near_green day
// instead of its own B-grade "Hit your essentials" template, which used the
// same restrictive language for a genuinely moderate (40-54) score AND a
// near-green (55-62) one even though the internal grade (B) doesn't
// distinguish them. The canonical grade is UNCHANGED (still 'B') — only the
// user-facing copy for this specific tier now comes from here, so Health and
// Today can never describe the same near-green day with materially
// different restrictiveness again.
const NEAR_GREEN_HEADLINE = 'Near green — train roughly as planned';
const NEAR_GREEN_PRESCRIPTION =
  "Train roughly as planned: your essentials, a real workout, and your important work in the morning. You're close enough to fully recovered that there's no automatic need to scale back — let how you feel be the final call.";

// The only independent canonical signals allowed to add cautionary language
// to an otherwise-reassuring near-green (solid_near_green) tier. A bare score
// in that tier never triggers caution on its own — only one of these.
const RISK_FLAGS = Object.freeze({
  sleep_debt: 'meaningful sleep debt',
  load_spike: 'a training load spike',
  illness_context: 'illness or an unusual context',
  hrv_depressed: 'markedly depressed HRV',
  rhr_elevated: 'an elevated resting heart rate',
  poor_self_report: 'a poor self-report',
});

function describeRiskFlag(flag) {
  return RISK_FLAGS[flag] || null;
}

/**
 * ONE shared derivation of recovery risk flags from already-computed
 * canonical inputs — the single place threshold/flag-selection logic lives,
 * so liveRecovery/computeHealthComposites/predictCapacity/Ask/voice can
 * never check a different SUBSET of flags for the same underlying signals
 * again (previously: predictCapacity never checked rhr_elevated, and the
 * live path — the one Ask/voice/the Health card actually read — computed no
 * risk flags at all, so a near-green score's one legitimate caution
 * mechanism silently never fired for those surfaces).
 *
 * Each input is a value the CALLER already computed via its own existing
 * canonical source (sleepDebt()/sleepBalance7(), ACWR banding, the recovery
 * score's own hrv/restingHr subscores) — this function only owns the
 * threshold logic, not signal computation itself, so it doesn't force every
 * caller onto one sleep-debt model.
 *
 * @param {object} [inputs]
 * @param {number} [inputs.sleepDebtHours]
 * @param {string} [inputs.loadBand] 'high' | 'optimal' | 'low'
 * @param {number} [inputs.hrvSubScore] 0-100 vs personal baseline
 * @param {number} [inputs.restingHrSubScore] 0-100 vs personal baseline
 * @returns {string[]} zero or more RISK_FLAGS keys
 */
function deriveRiskFlags({ sleepDebtHours, loadBand, hrvSubScore, restingHrSubScore } = {}) {
  const flags = [];
  if (loadBand === 'high') flags.push('load_spike');
  if (sleepDebtHours != null && sleepDebtHours >= 5) flags.push('sleep_debt');
  if (hrvSubScore != null && hrvSubScore < 30) flags.push('hrv_depressed');
  if (restingHrSubScore != null && restingHrSubScore < 30) flags.push('rhr_elevated');
  return flags;
}

/**
 * The single semantic entry point every consumer surface should call for a
 * recovery score's user-facing presentation. Pure; returns null without a
 * score.
 *
 * @param {number} score 0-100 composite (or self-report proxy) recovery score
 * @param {object} [opts]
 * @param {string} [opts.band] canonical band, if already computed elsewhere
 *   (recoveryBand's own return) — passed through so this never has to
 *   recompute or risk disagreeing with the canonical value. Derived from
 *   the score itself if omitted.
 * @param {string[]} [opts.riskFlags] zero or more RISK_FLAGS keys — the only
 *   mechanism by which a solid_near_green score may still get cautious
 *   guidance (an independent canonical signal, never the bare score alone).
 * @returns {{ tier: string, label: string, color: string, band: string,
 *   guidance: string, riskFlags: string[] } | null}
 */
function recoveryPresentation(score, { band, riskFlags = [] } = {}) {
  if (score == null || !Number.isFinite(score)) return null;
  const tierInfo = presentationTierFor(score);
  if (!tierInfo) return null;
  const resolvedBand = band || canonicalBand(score);

  let guidance = BASE_GUIDANCE[tierInfo.tier];
  const flags = (riskFlags || []).filter((f) => RISK_FLAGS[f]);
  if (tierInfo.tier === 'solid_near_green' && flags.length) {
    const descs = flags.map(describeRiskFlag);
    guidance += ` That said, keep today more conservative given ${descs.join(' and ')} — let how you feel be the final call.`;
  }

  return {
    tier: tierInfo.tier,
    label: tierInfo.label,
    color: tierInfo.color,
    band: resolvedBand,
    guidance,
    riskFlags: flags,
  };
}

module.exports = {
  BASE_GUIDANCE,
  RISK_FLAGS,
  NEAR_GREEN_HEADLINE,
  NEAR_GREEN_PRESCRIPTION,
  describeRiskFlag,
  deriveRiskFlags,
  recoveryPresentation,
};
