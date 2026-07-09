// Shared per-source staleness config + a single Monarch health signal — see
// the engineering review's #8. The staleness threshold table was copy-pasted
// three times (src/routes/briefing.js twice — the full builder and the
// scoped chief-brief-only retry — and src/routes/recommendations.js once,
// each with a slightly different field name and, in briefing.js's case, a
// narrower subset of sources), which is exactly the class of drift risk the
// review flagged: a threshold tuned in one copy silently doesn't apply to
// the others.
//
// Doesn't touch the actual Monarch fetch strategies (CSV import / GraphQL-
// direct / MCP sync) — those differ for real reasons (different auth,
// different data richness, a deliberate CSV -> GraphQL -> MCP fallback
// chain) and rewriting them is a much larger, riskier change than this
// session's "move and consolidate, don't rewrite working logic" approach
// allows for live financial-sync code. What WAS genuinely duplicated waste —
// the health/staleness signal callers need to reason about "is my wealth
// data current" — is what this module consolidates.
const STALE_THRESHOLDS_H = {
  eight_sleep_api:  { hours: 26, label: 'recovery/sleep metrics' },
  monarch_mcp_sync: { hours: 26, label: 'wealth/spending data' },
  monarch:          { hours: 48, label: 'wealth data' },
  health:           { hours: 6,  label: 'activity/steps' },
  checkin:          { hours: 36, label: 'mood/energy/focus' },
  habits:           { hours: 36, label: 'habits' },
  readwise:         { hours: 72, label: 'highlights' },
};
const DEFAULT_STALE_H = 72;

/** Pure: staleness info for one `sources` row. */
function sourceStaleness(s, now = Date.now()) {
  const thresh = STALE_THRESHOLDS_H[s.id] ?? { hours: DEFAULT_STALE_H, label: null };
  const hoursAgo = s.last_sync_at ? (now - new Date(s.last_sync_at).getTime()) / 3_600_000 : null;
  const isStale = hoursAgo == null || hoursAgo > thresh.hours;
  return { hoursAgo, isStale, thresholdHours: thresh.hours, label: thresh.label };
}

/**
 * Data gaps worth caveating in an LLM prompt — same "DATA GAPS —..." line
 * previously built inline (identically) in briefing.js's two call sites.
 * Only reports sources with an explicit threshold AND at least one prior
 * sync (a never-synced optional connector isn't a "gap," it's just unused).
 */
function describeDataGaps(sources, now = Date.now()) {
  const gaps = [];
  for (const s of sources) {
    if (!STALE_THRESHOLDS_H[s.id] || !s.last_sync_at) continue;
    const { hoursAgo, isStale, label } = sourceStaleness(s, now);
    if (isStale) gaps.push(`${s.display_name || s.id} (${label}, last synced ${Math.round(hoursAgo)}h ago)`);
  }
  return gaps;
}

/**
 * The single Monarch health signal the review asked for. Wealth data can
 * come from up to two independently-tracked `sources` rows — `monarch`
 * (CSV import / the GraphQL-direct fallback, which shares its id) and
 * `monarch_mcp_sync` (the primary, richer path) — so "is Monarch healthy"
 * isn't answerable from either row alone; a caller checking only one could
 * report "fine" while the other has been silently broken for days (this
 * exact gap is why briefing.js's staleness alert already checks both rows,
 * per its own comment — this generalizes that into one reusable answer
 * instead of the inline two-row check that only briefing.js had).
 */
function getMonarchHealth(sources, now = Date.now()) {
  const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
  const rows = ['monarch_mcp_sync', 'monarch']
    .filter((id) => byId[id])
    .map((id) => ({ id, ...sourceStaleness(byId[id], now), lastError: byId[id].last_error ?? null }));

  if (!rows.length) return { configured: false, healthy: false, rows: [] };

  // Healthy if AT LEAST ONE tracked path is fresh — mirrors the fallback
  // relationship between the paths (MCP down but a recent CSV import still
  // means current-enough data, and vice versa).
  const healthy = rows.some((r) => !r.isStale);
  const freshest = rows.reduce((a, b) => (a.hoursAgo ?? Infinity) <= (b.hoursAgo ?? Infinity) ? a : b);
  return { configured: true, healthy, rows, freshestHoursAgo: freshest.hoursAgo ?? null };
}

module.exports = { STALE_THRESHOLDS_H, DEFAULT_STALE_H, sourceStaleness, describeDataGaps, getMonarchHealth };
