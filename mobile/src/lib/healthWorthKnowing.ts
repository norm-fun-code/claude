// Health tab redesign (audit rec #4) — "Worth knowing" ranks and caps the
// health-domain findings the backend already curated (BriefingData
// .healthInsights, backend/src/store/findings.js via briefing.js) down to at
// most 2 for the landing page. Pure, no new insight generation/ranking
// authority — this only re-orders and dedupes what the server already sent,
// the same way brain/radar.js ranks candidates for Today's On My Radar.
import type { Insight } from '../hooks/useBriefing';

// Tier 1 (highest): a live deviation that calls for a decision today.
const TIER1_TYPES = new Set(['anomaly', 'strain', 'over_budget']);
// Tier 2: a newly-confirmed or materially-changed personal pattern.
const TIER2_TYPES = new Set(['correlation', 'sleep_impact', 'activity_impact', 'cross_context', 'habit_split']);
// Tier 3: a real progression/consistency milestone.
const TIER3_TYPES = new Set(['training_load', 'habit_consistency', 'fitness', 'sleep_consistency', 'sleep_regularity']);
// Tier 4 (lowest): a data-quality issue affecting today's read, not a finding
// about the user — e.g. a provisional/stale-source flag.
const TIER4_TYPES = new Set(['sleep_debt', 'sleep_surplus', 'data_quality', 'recovery']);

function tierOf(insight: Insight): number {
  if (TIER1_TYPES.has(insight.type)) return 1;
  if (TIER2_TYPES.has(insight.type)) return 2;
  if (TIER3_TYPES.has(insight.type)) return 3;
  if (TIER4_TYPES.has(insight.type)) return 4;
  return 3; // unknown types default to "milestone" tier rather than top/bottom
}

// Sleep-adjacent types whose title/detail commonly restate the same
// sleep→autonomic-signal observation from two angles (HRV vs resting HR) —
// only the more specific/higher-confidence one should surface, never both.
const SLEEP_AUTONOMIC_TYPES = new Set(['sleep_impact', 'correlation']);
const HRV_RE = /\bhrv\b/i;
const RHR_RE = /\bresting\s*h(?:eart\s*rate|r)\b|\brhr\b/i;

function mentionsHrv(ins: Insight): boolean {
  return HRV_RE.test(ins.title) || HRV_RE.test(ins.detail ?? '');
}
function mentionsRhr(ins: Insight): boolean {
  return RHR_RE.test(ins.title) || RHR_RE.test(ins.detail ?? '');
}

/** Pure: collapse a same-day sleep→HRV and sleep→resting-HR observation pair
 *  into one — keeping the higher-confidence (or, tied, the first) of the two.
 *  Every other insight passes through untouched. */
export function dedupeSleepAutonomicInsights(insights: Insight[]): Insight[] {
  const sleepAutonomic = insights.filter((i) => SLEEP_AUTONOMIC_TYPES.has(i.type) && (mentionsHrv(i) || mentionsRhr(i)));
  if (sleepAutonomic.length < 2) return insights;

  const hrvOnes = sleepAutonomic.filter(mentionsHrv);
  const rhrOnes = sleepAutonomic.filter((i) => mentionsRhr(i) && !mentionsHrv(i));
  if (hrvOnes.length === 0 || rhrOnes.length === 0) return insights;

  // Keep the higher-confidence HRV one, drop every RHR-only duplicate — HRV
  // is the more sensitive autonomic signal, so it's the more informative half
  // of the pair when both fired from the same underlying sleep night.
  const keep = [...hrvOnes].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  const dropKeys = new Set(rhrOnes.map((i) => i.dismissKey ?? i.title));
  return insights.filter((i) => !dropKeys.has(i.dismissKey ?? i.title) || i === keep);
}

/** Pure: rank + dedupe + cap to at most `max` (default 2) for the Health
 *  landing page's "Worth knowing" section. Order: tier (deviation > pattern >
 *  milestone > data-quality), then higher confidence first. */
export function selectWorthKnowing(insights: Insight[] | null | undefined, max = 2): Insight[] {
  if (!Array.isArray(insights) || insights.length === 0) return [];
  const deduped = dedupeSleepAutonomicInsights(insights);
  return [...deduped]
    .sort((a, b) => {
      const t = tierOf(a) - tierOf(b);
      if (t !== 0) return t;
      return (b.confidence ?? 0) - (a.confidence ?? 0);
    })
    .slice(0, max);
}
