// Chief Brief regression fix — the one pure merge function every incoming
// briefing response (cold launch, foreground refresh, pull/reload, full
// rebuild completion, scoped Chief Brief retry, status-probe completion)
// goes through before it ever reaches useBriefing's state or the persisted
// cache. The single rule this exists to enforce: an incoming response with
// no usable Chief Brief must never overwrite an existing, same-local-day
// last-good Chief Brief with null/degraded content — every OTHER field in
// the payload (Today, Radar, weather, wealth, etc.) always refreshes from
// the incoming response as normal. See backend routes/briefing.js's
// identical-in-spirit store/briefings.js `resolveLastGoodChiefBrief` — the
// server already applies this rule when constructing a response, but a
// stale/poisoned client cache (written before this fix, or by a future
// regression) needs the SAME protection applied again on the client.
import type { BriefingData, ChiefBrief } from '../hooks/useBriefing';

/** Pure: does this ChiefBrief have the minimum shape to actually show
 *  something? Mirrors backend store/briefings.js's
 *  isStructurallyUsableChiefBrief — kept in sync deliberately, not derived,
 *  since the two run in different runtimes. */
export function isUsableChiefBrief(cb: ChiefBrief | null | undefined): cb is ChiefBrief {
  if (!cb || typeof cb !== 'object') return false;
  return Boolean(cb.synthesis || cb.action || cb.risk || cb.move);
}

/** Pure: is this BriefingData's chiefBrief fit to serve as "last known good"
 *  — usable content, and not flagged pending. Deliberately a plain boolean,
 *  not a `data is BriefingData` type predicate: callers here (e.g.
 *  `incoming`) are often already typed as non-nullable `BriefingData`, and a
 *  type predicate identical to the input type collapses the negated branch
 *  to `never`. */
function isLastGoodCandidate(data: BriefingData | null | undefined): boolean {
  return Boolean(data) && !data!.chiefBriefPending && isUsableChiefBrief(data!.chiefBrief);
}

/**
 * The one merge point for every incoming briefing payload.
 *
 * - When `incoming` carries a publishable Chief Brief (or there's no
 *   existing last-good card to protect), `incoming` is authoritative as-is.
 * - When `incoming` has no usable Chief Brief but `existing` does — AND
 *   `existing` describes the SAME local day as `incoming` (never carry
 *   yesterday's content forward as today's) — retain `existing`'s Chief
 *   Brief content while taking every other field from `incoming` (Today,
 *   Radar, weather, wealth, etc. always refresh normally). The attempt-state
 *   fields (chiefBriefQuality / chiefBriefAttempt) still reflect the
 *   INCOMING (latest) attempt, so the UI can show "Couldn't refresh" while
 *   the content itself stays put.
 */
export function mergeBriefingResponse(existing: BriefingData | null, incoming: BriefingData): BriefingData {
  if (isLastGoodCandidate(incoming)) return incoming;
  if (existing == null || !isLastGoodCandidate(existing)) return incoming;
  const lastGood: BriefingData = existing;

  // Same-local-day only — a previous-day Chief Brief must never masquerade
  // as today's. Both sides carry `localDate` on any build since the Context
  // Understanding Layer; if either is missing (a very old cache), fail
  // closed and don't carry forward rather than risk a cross-day leak.
  if (!lastGood.localDate || !incoming.localDate || lastGood.localDate !== incoming.localDate) {
    return incoming;
  }

  return {
    ...incoming,
    chiefBrief: lastGood.chiefBrief,
    morningFocus: lastGood.morningFocus,
    chiefBriefStale: true,
    chiefBriefPending: false,
    chiefBriefGoalsStale: lastGood.chiefBriefGoalsStale,
    goalsWeekStart: lastGood.goalsWeekStart,
    chiefBriefProvenance: lastGood.chiefBriefProvenance ?? {
      source: 'last_good',
      localDate: lastGood.localDate ?? null,
      builtAt: lastGood.builtAt ?? null,
      snapshotId: lastGood.snapshotId ?? null,
    },
    // Attempt state deliberately comes from `incoming` — content is
    // protected, but the attempt verdict must stay honest about what just
    // happened (a failed refresh really did fail).
    chiefBriefAttempt: incoming.chiefBriefAttempt ?? null,
    chiefBriefQuality: incoming.chiefBriefQuality ?? null,
  };
}

/**
 * Cache migration (v1 -> v2): recover a structurally valid same-day Chief
 * Brief from an already-poisoned v1 cache (one written by the pre-fix
 * client, which could have persisted `chiefBrief: null` over a previously
 * good card). `todayLocalDate` is the caller's own YYYY-MM-DD so this never
 * needs Date.now() internally (kept pure/testable).
 *
 * - A structurally usable, same-day cached Chief Brief survives (marked
 *   stale/last_good — it's not a live fetch result).
 * - A null/degraded/pending cached Chief Brief, or one from a PRIOR day, is
 *   dropped — the rest of the cached payload survives untouched either way
 *   (Today/Radar/weather are still useful to show instantly while a fresh
 *   fetch is in flight).
 */
export function migrateV1Cache(v1: BriefingData | null, todayLocalDate: string): BriefingData | null {
  if (!v1) return null;
  if (!isUsableChiefBrief(v1.chiefBrief) || v1.chiefBriefPending) {
    return { ...v1, chiefBrief: null, chiefBriefPending: true, chiefBriefStale: false };
  }
  if (v1.localDate && v1.localDate !== todayLocalDate) {
    return { ...v1, chiefBrief: null, chiefBriefPending: true, chiefBriefStale: false };
  }
  return v1;
}
