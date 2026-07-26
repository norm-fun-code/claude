// "On My Radar" — the server-ranked replacement for the old fixed three-tile
// Health/Wealth/Review preview row (todayCommandCenter.js's old
// buildPreviews). Candidates are gathered ONLY from data the caller already
// computed for this exact response (wealthInsights, weeklyReview, recovery,
// chiefBrief, risk) — no new fetch, no new LLM call. Each candidate carries a
// materiality tier and an explicit dedup topic; ranking/capping happens here,
// never a guaranteed one-card-per-domain slot — a domain that has nothing
// material to say simply contributes no candidate.
//
// Reuses store/dismissedInsights.js's existing stable dismissKey (type +
// normalized title) so "not useful" on a radar card is the SAME persistence
// mechanism "What The Data Shows" insights already use — not a second store.
const { dismissKey } = require('../store/dismissedInsights');

function wordSet(text) {
  return new Set(
    String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2)
  );
}

/** True when `text` mentions any of `keywords` — a bounded, explicit
 *  vocabulary check (same spirit as todayCommandCenter's findRiskEvidence
 *  `/worth attention/i` gate), not a fragile arbitrary string compare. */
function topicOverlaps(text, keywords) {
  const words = wordSet(text);
  return keywords.some((k) => words.has(k));
}

/** Fraction of `phrase`'s significant words also present in `text`. */
function overlapRatio(text, phrase) {
  const pw = wordSet(phrase);
  if (!pw.size) return 0;
  const tw = wordSet(text);
  let common = 0;
  for (const w of pw) if (tw.has(w)) common++;
  return common / pw.size;
}

/** Wealth candidate — reuses buildWealthInsights' OWN top-ranked insight
 *  title/detail verbatim (already dollar-impact gated — TRUTH10), never
 *  re-derived. Suppressed when Chief Brief's MOVE field is already
 *  describing this SAME insight (never repeat a claim already conveyed). */
function wealthCandidate({ wealthInsights, chiefBrief }) {
  const top = (wealthInsights || [])[0];
  if (!top?.title) return null;
  if (overlapRatio(chiefBrief?.move, top.title) >= 0.5) return null;
  return {
    domain: 'wealth', dedupeTopic: 'wealth_insight', sourceId: top.title,
    tier: 1, material: true, timeSensitive: false,
    headline: top.title,
    whyNow: top.detail || 'Worth a look before it compounds.',
    evidenceSummary: top.detail || null,
    asOf: top.asOf || null,
    actionLabel: 'Open in Wealth',
    destination: {
      surface: 'wealth', entityType: 'wealthInsight', entityId: top.title,
      anchor: top.title, snapshotId: null, fallbackRoute: 'wealth',
    },
  };
}

/** Stale wealth sync candidate — only when there's no material insight to
 *  show instead (see wealthCandidate above) AND the source genuinely hasn't
 *  synced in a while; an uncertainty about whether today's numbers are
 *  current, not a routine on-track metric. */
function staleWealthSyncCandidate({ wealthInsights, wealth }) {
  if ((wealthInsights || [])[0]) return null; // a real insight already covers this domain
  if (!wealth?.sourceSyncedAt) return null;
  const ageH = (Date.now() - new Date(wealth.sourceSyncedAt).getTime()) / 36e5;
  if (ageH <= 40) return null;
  return {
    domain: 'wealth', dedupeTopic: 'wealth_stale_sync', sourceId: 'wealth_stale_sync',
    tier: 3, material: false, timeSensitive: true,
    headline: 'Wealth data may be stale',
    whyNow: `Monarch hasn't synced in ${Math.round(ageH)}h — today's numbers may not reflect recent activity.`,
    evidenceSummary: null,
    asOf: wealth.sourceSyncedAt,
    actionLabel: 'Open in Wealth',
    destination: {
      surface: 'wealth', entityType: null, entityId: null,
      anchor: null, snapshotId: null, fallbackRoute: 'wealth',
    },
  };
}

/** Weekly review candidate — the review itself IS the exact target (only
 *  ever one "this week's" review live at a time), so no anchor is needed —
 *  opening it is opening the exact entity, never a generic list. */
function weeklyReviewCandidate({ weeklyReview }) {
  if (!weeklyReview?.headline) return null;
  return {
    domain: 'review', dedupeTopic: 'weekly_review', sourceId: weeklyReview.generatedAt || weeklyReview.headline,
    tier: 4, material: false, timeSensitive: false,
    headline: 'Your weekly review is ready',
    whyNow: weeklyReview.headline,
    evidenceSummary: null,
    asOf: weeklyReview.generatedAt || null,
    actionLabel: 'Read the 3-minute review',
    destination: {
      surface: 'review', entityType: 'weeklyReview', entityId: weeklyReview.generatedAt || null,
      anchor: null, snapshotId: null, fallbackRoute: 'review',
    },
  };
}

const PROVISIONAL_KEYWORDS = ['provisional', 'unsynced', 'proxy'];
/** Recovery-provisional candidate — surfaced ONLY when this exact
 *  uncertainty isn't already sufficiently explained in the served Chief
 *  Brief (NOW/RISK) — repeating it would just be noise under a headline
 *  that already said it. */
function recoveryProvisionalCandidate({ recovery, chiefBrief, risk }) {
  if (!recovery?.proxy) return null;
  const alreadyExplained =
    topicOverlaps(chiefBrief?.synthesis, PROVISIONAL_KEYWORDS) ||
    topicOverlaps(chiefBrief?.risk, PROVISIONAL_KEYWORDS) ||
    topicOverlaps(risk?.rationale, PROVISIONAL_KEYWORDS) ||
    /self-report/i.test(chiefBrief?.synthesis || '') ||
    /self-report/i.test(risk?.rationale || '');
  if (alreadyExplained) return null;
  return {
    domain: 'health', dedupeTopic: 'recovery_provisional', sourceId: 'recovery_provisional',
    tier: 3, material: false, timeSensitive: true,
    headline: 'Recovery is provisional',
    whyNow: 'Eight Sleep hasn’t synced overnight data — today’s training read is based on your self-report, not a device reading.',
    evidenceSummary: 'Self-reported recovery; not yet confirmed by an overnight device sync.',
    asOf: recovery.asOf || null,
    actionLabel: 'Open in Health',
    destination: {
      surface: 'health', entityType: 'recovery', entityId: 'today',
      anchor: 'recovery', snapshotId: null, fallbackRoute: 'health',
    },
  };
}

/**
 * Build the ranked "On My Radar" list. 0–2 cards under normal
 * conditions; a 3rd survives ONLY when it is independently both `material`
 * and `timeSensitive` (never merely "there happened to be a 3rd domain").
 * Ranking order (ties broken by insertion order, itself already
 * materiality-first): (1) material item requiring action, (2) time-sensitive
 * unresolved item, (3) important uncertainty affecting a decision, (4) newly
 * available review/artifact, (5) meaningful positive milestone.
 *
 * @param {object} input
 * @param {Array} input.wealthInsights
 * @param {object|null} input.wealth
 * @param {object|null} input.weeklyReview
 * @param {object|null} input.recovery
 * @param {object|null} input.chiefBrief
 * @param {object|null} input.risk the ALREADY-BUILT todayCommandCenter risk
 *   field (or null) — used only for its `evidence.kind` stable topic, to
 *   dedup a radar card against a risk already shown, never re-derived.
 * @param {string|null} input.snapshotId
 * @param {Set<string>} [input.dismissed] dismissed-insight keys from
 *   store/dismissedInsights.js's dismissedKeys() — pass the SAME set the
 *   caller already fetched for insights/wealthInsights/healthInsights this
 *   response, not a second query.
 * @returns {Array<object>} ranked, capped radar cards.
 */
function buildRadarCards({ wealthInsights, wealth, weeklyReview, recovery, chiefBrief, risk, snapshotId, dismissed }) {
  const dismissedSet = dismissed instanceof Set ? dismissed : new Set();

  const candidates = [
    wealthCandidate({ wealthInsights, chiefBrief }),
    staleWealthSyncCandidate({ wealthInsights, wealth }),
    weeklyReviewCandidate({ weeklyReview }),
    recoveryProvisionalCandidate({ recovery, chiefBrief, risk }),
  ].filter(Boolean);

  // Dedup vs RISK: findRiskEvidence's `kind` ('forecast' | 'capacity' |
  // 'anomaly') is the SAME stable topic identity todayCommandCenter.risk
  // already carries — a health-domain radar card is suppressed when RISK
  // is already showing a health-derived anomaly, so the same signal never
  // shows up twice on the same screen.
  const riskKind = risk?.evidence?.kind ?? null;
  const survivors = candidates.filter((c) => {
    if (riskKind === 'anomaly' && c.domain === 'health') return false;
    const key = dismissKey({ type: `radar_${c.dedupeTopic}`, title: c.headline });
    if (dismissedSet.has(key)) return false;
    c._dismissKey = key;
    return true;
  });

  const ranked = survivors.slice().sort((a, b) => a.tier - b.tier);
  const top = ranked.slice(0, 2);
  const third = ranked[2];
  const finalList = third && third.material && third.timeSensitive ? [...top, third] : top;

  return finalList.map((c) => ({
    stableId: `radar:${snapshotId ?? 'none'}:${c.dedupeTopic}`,
    domain: c.domain,
    entityId: c.sourceId ?? null,
    snapshotId: snapshotId ?? null,
    priority: c.tier,
    status: 'open',
    severity: c.tier <= 2 ? 'material' : (c.tier === 3 ? 'watch' : 'info'),
    headline: c.headline,
    whyNow: c.whyNow,
    evidenceSummary: c.evidenceSummary,
    asOf: c.asOf,
    actionLabel: c.actionLabel,
    destination: c.destination,
    dismissable: true,
    dismissKey: c._dismissKey,
  }));
}

module.exports = { buildRadarCards, topicOverlaps, overlapRatio };
