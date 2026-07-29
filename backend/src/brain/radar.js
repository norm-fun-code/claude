// "On My Radar" — the server-ranked replacement for the old fixed three-tile
// Health/Wealth/Review preview row (todayCommandCenter.js's old
// buildPreviews). Candidates are gathered ONLY from data the caller already
// computed for this exact response (wealthInsights, weeklyReview, recovery,
// chiefBrief, risk) — no new fetch, no new LLM call.
//
// Semantic contract (On My Radar audit): ranking and presentation are driven
// entirely by the STRUCTURED semantic fields the authoritative fact source
// declares — attentionClass/material/timeSensitive/actionable/direction/
// reasonCode (see services/wealth-insights.js's module header for the full
// contract). This module never infers severity from array position or from
// matching specific title text — the production bug this fixes was exactly
// that: wealthInsights[0] was stamped material/tier-1 unconditionally, so a
// POSITIVE "saving 28% of income" result rendered as a red "Needs attention"
// alert. Two producers (weeklyReview, recovery) aren't arrays of many
// candidates to rank — there's only ever one of each — so THIS module is
// their "authoritative source" for the same structured fields, declared
// directly in each candidate builder below rather than inferred later.
//
// Reuses store/dismissedInsights.js's existing stable dismissKey (type +
// normalized title). For a wealth insight, the SAME dismissKey the Wealth
// tab's own "What The Data Shows" list would compute is reused verbatim (not
// a radar-specific derivative) — dismissing it from Radar also dismisses it
// there, and vice versa, because it's the SAME underlying fact, not two.
// The other candidate types (stale sync, weekly review, recovery-provisional)
// have no equivalent domain-surface entry, so they keep a radar-scoped key.
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

const fmtMoney = (n) => (n < 0 ? '-$' + Math.round(Math.abs(n)).toLocaleString('en-US') : '$' + Math.round(n).toLocaleString('en-US'));

// Short, purpose-written "why now" copy keyed by the wealth insight's own
// `reasonCode` — structured metadata the producer (wealth-insights.js)
// already declared, never a regex/string match against title or detail.
// Distinct from `detail` (the Wealth tab's full narrative) and from the
// evidence items below (the distinct supporting numbers) — this is THE fix
// for the "identical whyNow and evidenceSummary" defect (audit problem #5).
const WEALTH_WHY_NOW = {
  overspending_30d: () => 'You spent more than you brought in over the last 30 days.',
  spending_spike: (i) => `${i.category || 'This category'} is running well above your usual pace this month.`,
  over_budget: (i) => `${i.category || 'This category'} is already past its budget for this month.`,
  pacing_over_budget: (i) => `${i.category || 'This category'} is on pace to go over budget this month.`,
  net_worth_decline: () => 'Your net worth trend has turned negative over the last few months.',
  net_worth_growth_milestone: () => 'Your net worth is growing at a notably strong pace.',
};

// Compact structured evidence, keyed by the insight's `evidence.kind` — the
// SAME discriminant wealth-insights.js already attaches to every insight it
// produces. Renders as short label/value rows on the client instead of
// re-parsing prose, and never duplicates whyNow's reasoning-in-prose.
const WEALTH_EVIDENCE_ITEMS = {
  savings_rate: (e) => [
    { label: 'Income (30d)', value: fmtMoney(e.income) },
    { label: 'Spending (30d)', value: fmtMoney(e.spending) },
    { label: 'Saved', value: `${e.ratePct}%` },
    { label: 'Window', value: `${e.windowDays} days` },
  ],
  spending_pattern: (e) => [
    { label: e.category || 'This month', value: `${fmtMoney(e.current)} so far` },
    { label: 'Usual average', value: fmtMoney(e.avg) },
    { label: 'Projected', value: fmtMoney(e.projected) },
  ],
  budget_pacing: (e) => [
    { label: e.category || 'Budget', value: `${fmtMoney(e.actual)} of ${fmtMoney(e.budget)}` },
    { label: 'Pace', value: `${Math.round(e.pace * 100)}% of expected` },
  ],
  net_worth_path: (e) => [
    { label: 'Current', value: fmtMoney(e.current) },
    { label: 'Monthly change', value: fmtMoney(e.monthlyChange) },
  ],
  investments: (e) => [
    { label: 'Portfolio value', value: fmtMoney(e.totalValue) },
    ...(typeof e.periodChange === 'number' ? [{ label: '7-day change', value: fmtMoney(e.periodChange) }] : []),
  ],
};

/** Wealth candidate — selects the first insight in buildWealthInsights'
 *  OWN ranked output whose `attentionClass` is Radar-eligible (i.e. NOT
 *  'informational' — routine on-track data never becomes a card), reusing
 *  its title/reasonCode/evidence verbatim, never re-derived or re-ranked by
 *  position. Suppressed when Chief Brief's MOVE field is already describing
 *  this SAME insight (never repeat a claim already conveyed). */
function wealthCandidate({ wealthInsights, chiefBrief }) {
  const top = (wealthInsights || []).find((i) => i?.attentionClass && i.attentionClass !== 'informational');
  if (!top?.title) return null;
  if (overlapRatio(chiefBrief?.move, top.title) >= 0.5) return null;
  const whyNowFn = WEALTH_WHY_NOW[top.reasonCode];
  const itemsFn = top.evidence?.kind ? WEALTH_EVIDENCE_ITEMS[top.evidence.kind] : null;
  return {
    domain: 'wealth', dedupeTopic: 'wealth_insight', sourceId: top.title,
    attentionClass: top.attentionClass, material: Boolean(top.material), timeSensitive: Boolean(top.timeSensitive),
    headline: top.title,
    whyNow: whyNowFn ? whyNowFn(top) : top.title,
    evidenceSummary: null,
    evidenceItems: itemsFn ? itemsFn(top.evidence) : null,
    asOf: top.asOf || null,
    actionLabel: 'Open in Wealth',
    destination: {
      surface: 'wealth', entityType: 'wealthInsight', entityId: top.title,
      anchor: top.title, snapshotId: null, fallbackRoute: 'wealth',
    },
    // Reuse the SAME dismissKey the Wealth tab's own insight list would
    // compute for this exact insight (type + normalized title) — one
    // dismissal covers both surfaces, since it's one underlying fact.
    dismissKeyOverride: dismissKey(top),
  };
}

/** Stale wealth sync candidate — only when there's no material insight to
 *  show instead (see wealthCandidate above) AND the source genuinely hasn't
 *  synced in a while; an uncertainty about whether today's numbers are
 *  current, not a routine on-track metric. */
function staleWealthSyncCandidate({ wealthInsights, wealth }) {
  const hasEligibleInsight = (wealthInsights || []).some((i) => i?.attentionClass && i.attentionClass !== 'informational');
  if (hasEligibleInsight) return null; // a real actionable insight already covers this domain
  if (!wealth?.sourceSyncedAt) return null;
  const ageH = (Date.now() - new Date(wealth.sourceSyncedAt).getTime()) / 36e5;
  if (ageH <= 40) return null;
  return {
    domain: 'wealth', dedupeTopic: 'wealth_stale_sync', sourceId: 'wealth_stale_sync',
    attentionClass: 'watch', material: false, timeSensitive: true,
    headline: 'Wealth data may be stale',
    whyNow: `Monarch hasn't synced in ${Math.round(ageH)}h — today's numbers may not reflect recent activity.`,
    evidenceSummary: null, evidenceItems: null,
    asOf: wealth.sourceSyncedAt,
    actionLabel: 'Open in Wealth',
    destination: {
      surface: 'wealth', entityType: null, entityId: null,
      anchor: null, snapshotId: null, fallbackRoute: 'wealth',
    },
  };
}

/** Weekly review candidate — a newly-available artifact ('ready'), not an
 *  alert. The review itself IS the exact target (only ever one "this week's"
 *  review live at a time), so no anchor is needed — opening it is opening
 *  the exact entity, never a generic list. whyNow is the review's OWN
 *  headline (distinct from the card's generic "ready" headline below). */
function weeklyReviewCandidate({ weeklyReview }) {
  if (!weeklyReview?.headline) return null;
  // Stable identity, preferring the persisted row's own id, then its
  // canonical weekStart, then generatedAt — NEVER the headline (visible
  // title text) or array position, per the canonical openWeeklyReview
  // contract (mobile identifies/fetches the exact review by this value).
  const stableId = weeklyReview.id ?? weeklyReview.weekStart ?? weeklyReview.generatedAt ?? null;
  return {
    domain: 'review', dedupeTopic: 'weekly_review', sourceId: stableId ?? 'weekly_review',
    attentionClass: 'ready', material: false, timeSensitive: false,
    headline: 'Your weekly review is ready',
    whyNow: weeklyReview.headline,
    evidenceSummary: null, evidenceItems: null,
    asOf: weeklyReview.generatedAt || null,
    actionLabel: 'Read the 3-minute review',
    destination: {
      surface: 'review', entityType: 'weeklyReview', entityId: stableId,
      reviewId: weeklyReview.id ?? null, weekStart: weeklyReview.weekStart ?? null,
      anchor: null, snapshotId: null, fallbackRoute: 'review',
    },
  };
}

const PROVISIONAL_KEYWORDS = ['provisional', 'unsynced', 'proxy'];
/** Recovery-provisional candidate — an unresolved uncertainty ('watch'),
 *  surfaced ONLY when this exact uncertainty isn't already sufficiently
 *  explained in the served Chief Brief (NOW/RISK) — repeating it would just
 *  be noise under a headline that already said it. */
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
    attentionClass: 'watch', material: false, timeSensitive: true,
    headline: 'Recovery is provisional',
    whyNow: 'Eight Sleep hasn’t synced overnight data — today’s training read is based on your self-report, not a device reading.',
    evidenceSummary: 'Self-reported recovery; not yet confirmed by an overnight device sync.',
    evidenceItems: null,
    asOf: recovery.asOf || null,
    actionLabel: 'Open in Health',
    destination: {
      surface: 'health', entityType: 'recovery', entityId: 'today',
      anchor: 'recovery', snapshotId: null, fallbackRoute: 'health',
    },
  };
}

// Ranking order — usefulness, not domain availability or array position:
//   1. action_required — a material issue that needs action now
//   2. watch            — a time-sensitive unresolved uncertainty
//   3. ready            — a newly available artifact worth reviewing
//   4. positive         — an exceptional positive milestone (never routine)
// 'informational' candidates are never constructed with this attentionClass
// reaching here — each builder above only assigns 'positive' when the
// underlying fact is independently material (see wealth-insights.js), so no
// separate "is this routine" filter is needed at this layer.
const RANK_BY_CLASS = { action_required: 1, watch: 2, ready: 3, positive: 4 };

/** A 3rd candidate survives the normal 2-card cap only when it's genuinely
 *  urgent on its own terms — a real material issue, or a time-sensitive
 *  uncertainty — never merely "there happened to be a 3rd domain with
 *  something to say." */
function survivesAsThird(c) {
  return c.attentionClass === 'action_required' || (c.attentionClass === 'watch' && c.timeSensitive);
}

/**
 * Build the ranked "On My Radar" list. 0–2 cards under normal conditions; a
 * 3rd survives ONLY when it independently qualifies per survivesAsThird()
 * above. See the ranking-order comment on RANK_BY_CLASS.
 *
 * @param {object} input
 * @param {Array} input.wealthInsights each entry carrying the semantic
 *   contract (attentionClass/material/timeSensitive/direction/reasonCode/
 *   evidence) — see services/wealth-insights.js.
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
    const key = c.dismissKeyOverride || dismissKey({ type: `radar_${c.dedupeTopic}`, title: c.headline });
    if (dismissedSet.has(key)) return false;
    c._dismissKey = key;
    return true;
  });

  const ranked = survivors.slice().sort((a, b) => (RANK_BY_CLASS[a.attentionClass] ?? 9) - (RANK_BY_CLASS[b.attentionClass] ?? 9));
  const top = ranked.slice(0, 2);
  const third = ranked[2];
  const finalList = third && survivesAsThird(third) ? [...top, third] : top;

  return finalList.map((c) => ({
    stableId: `radar:${snapshotId ?? 'none'}:${c.dedupeTopic}`,
    domain: c.domain,
    entityId: c.sourceId ?? null,
    snapshotId: snapshotId ?? null,
    priority: RANK_BY_CLASS[c.attentionClass] ?? 9,
    status: 'open',
    // The authoritative semantic status — presentation layers (mobile) map
    // this directly to color/label; never re-derive severity from priority.
    attentionClass: c.attentionClass,
    headline: c.headline,
    whyNow: c.whyNow,
    evidenceSummary: c.evidenceSummary,
    evidenceItems: c.evidenceItems,
    asOf: c.asOf,
    actionLabel: c.actionLabel,
    destination: c.destination,
    dismissable: true,
    dismissKey: c._dismissKey,
  }));
}

module.exports = { buildRadarCards, topicOverlaps, overlapRatio };
