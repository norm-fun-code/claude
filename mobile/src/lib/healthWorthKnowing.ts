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
const TIER2_TYPES = new Set([
  'correlation', 'sleep_impact', 'activity_impact', 'cross_context', 'habit_split',
  // Apple Watch daytime HRV/RHR vs lifestyle-lever findings (analyze.js
  // computeDaytimeCardio) — the same kind of measured lever->outcome pattern
  // as sleep_impact/activity_impact, just previously unlisted here (which
  // meant it only reached tier 3 by accident, via the buggy unknown-type
  // fallback below — now made explicit so fixing that fallback doesn't
  // silently demote it).
  'daytime_cardio',
]);
// Tier 3: a real progression/consistency milestone.
const TIER3_TYPES = new Set(['training_load', 'habit_consistency', 'fitness', 'sleep_consistency', 'sleep_regularity']);
// Tier 4 (lowest): a data-quality issue affecting today's read, not a finding
// about the user — e.g. a provisional/stale-source flag. Also where any
// unrecognized finding type defaults to: an unknown type has no basis for
// being treated as a confirmed milestone, so it must not be promoted above
// data-quality/informational priority.
const TIER4_TYPES = new Set(['sleep_debt', 'sleep_surplus', 'data_quality', 'recovery']);

function tierOf(insight: Insight): number {
  if (TIER1_TYPES.has(insight.type)) return 1;
  if (TIER2_TYPES.has(insight.type)) return 2;
  if (TIER3_TYPES.has(insight.type)) return 3;
  if (TIER4_TYPES.has(insight.type)) return 4;
  return 4; // unknown types default to low/informational priority, not milestone
}

/**
 * Stable semantic/evidence identity for dedup — deliberately narrow. Two
 * findings are the "same underlying observation" only when they carry the
 * same finding type AND resolve to the same metric/comparison basis in the
 * backend's evidence object (evidence.metric for a single-series finding
 * like `anomaly`; evidence.driver+evidence.outcome for a sleep/lever-driven
 * split like `sleep_impact`/`daytime_cardio`; evidence.a+evidence.b for a
 * pairwise `correlation`). Different metrics — e.g. HRV vs resting HR — are
 * different observations and must never collapse into one just because both
 * mention "autonomic tone" in prose or both derive from sleep. A finding
 * whose evidence doesn't match any known shape gets no identity (`null`) and
 * is never deduped against anything, rather than risk a false merge.
 */
function evidenceIdentity(insight: Insight): string | null {
  const ev = insight.evidence;
  if (!ev || typeof ev !== 'object') return null;
  const driver = typeof ev.driver === 'string' ? ev.driver : null;
  const outcome = typeof ev.outcome === 'string' ? ev.outcome : null;
  const lever = typeof ev.lever === 'string' ? ev.lever : null;
  const a = typeof ev.a === 'string' ? ev.a : null;
  const b = typeof ev.b === 'string' ? ev.b : null;
  const metric = typeof ev.metric === 'string' ? ev.metric : null;

  if (driver && outcome) return `${insight.type}:${driver}->${outcome}`;
  if (lever && outcome) return `${insight.type}:${lever}->${outcome}`;
  if (a && b) return `${insight.type}:${[a, b].sort().join('|')}`;
  if (metric) return `${insight.type}:${metric}`;
  return null;
}

/** Pure: collapse findings that share the exact same evidence identity
 *  (same type, same underlying metric/comparison) into the single
 *  highest-confidence representative. Findings with no resolvable identity,
 *  or with distinct identities (e.g. an HRV finding vs a resting-HR
 *  finding), always pass through untouched — this is intentionally narrower
 *  than the old title/detail text-matching approach, which suppressed a
 *  distinct resting-HR finding merely because an HRV sleep finding also
 *  fired. */
export function dedupeSleepAutonomicInsights(insights: Insight[]): Insight[] {
  const groups = new Map<string, Insight[]>();
  for (const ins of insights) {
    const id = evidenceIdentity(ins);
    if (!id) continue;
    const g = groups.get(id);
    if (g) g.push(ins); else groups.set(id, [ins]);
  }

  const drop = new Set<Insight>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keep = [...group].sort((x, y) => (y.confidence ?? 0) - (x.confidence ?? 0))[0];
    for (const ins of group) if (ins !== keep) drop.add(ins);
  }
  if (drop.size === 0) return insights;
  return insights.filter((i) => !drop.has(i));
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
