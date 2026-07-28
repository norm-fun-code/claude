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
  describeRiskFlag,
  recoveryPresentation,
};
