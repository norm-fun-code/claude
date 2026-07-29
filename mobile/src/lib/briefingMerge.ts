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
import type { BriefingData, ChiefBrief, WealthLanding } from '../hooks/useBriefing';

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

/** Pure: is this a usable Wealth landing projection worth displaying?
 *  Mirrors the shape backend/src/services/wealth-landing.js always returns
 *  when it successfully builds one (a `severity` field is always present). */
function isUsableWealthLanding(w: WealthLanding | null | undefined): w is WealthLanding {
  return Boolean(w) && typeof w === 'object' && typeof (w as WealthLanding).severity === 'string';
}

/** Carry forward the last-good Wealth landing projection when `incoming`
 *  transiently lacks one (e.g. a scoped rebuild response that doesn't touch
 *  wealth, or a Monarch call that briefly failed) — the exact same
 *  last-good-survives-a-transient-gap protection Chief Brief already gets.
 *  Applied on top of whichever base object the caller already built (either
 *  `incoming` as-is, or the Chief-Brief-protected merge below) so it's
 *  layer-independent. */
function withWealthLandingProtected(base: BriefingData, incoming: BriefingData, existing: BriefingData | null): BriefingData {
  if (isUsableWealthLanding(incoming.wealthLanding)) return base;
  if (!existing || !isUsableWealthLanding(existing.wealthLanding)) return base;
  return { ...base, wealthLanding: existing.wealthLanding, wealthLandingStale: true };
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
  if (isLastGoodCandidate(incoming)) return withWealthLandingProtected(incoming, incoming, existing);
  if (existing == null || !isLastGoodCandidate(existing)) return withWealthLandingProtected(incoming, incoming, existing);
  const lastGood: BriefingData = existing;

  // Same-local-day only — a previous-day Chief Brief must never masquerade
  // as today's. Both sides carry `localDate` on any build since the Context
  // Understanding Layer; if either is missing (a very old cache), fail
  // closed and don't carry forward rather than risk a cross-day leak. Note:
  // this same-day gate is Chief-Brief-specific — Wealth's last-good
  // protection below applies regardless of day (net worth doesn't reset at
  // midnight).
  if (!lastGood.localDate || !incoming.localDate || lastGood.localDate !== incoming.localDate) {
    return withWealthLandingProtected(incoming, incoming, existing);
  }

  const merged: BriefingData = {
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
  return withWealthLandingProtected(merged, incoming, existing);
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
/**
 * Pure: is this GET /briefing/by-snapshot/:snapshotId response valid to
 * display as the EXACT briefing a tapped morning-notification push
 * referenced (morning-notification lifecycle fix, item C)? Requires the
 * response to carry the SAME snapshotId the push named, and — if it carries
 * a localDate at all — that it's TODAY's, never a prior local day. A
 * delayed push tapped late (after midnight) must never masquerade its
 * content as today's; the caller falls back to a normal current-day load
 * instead.
 */
export function isValidPushSnapshot(
  content: BriefingData | null | undefined, snapshotId: string, todayLocalDate: string
): content is BriefingData {
  if (!content || content.snapshotId !== snapshotId) return false;
  if (content.localDate && content.localDate !== todayLocalDate) return false;
  return true;
}

// Cross-day lifecycle fix — every field this app's own architecture treats
// as day-bound (Wisdom, Today plan, calendar, weather, forecasts, recovery/
// training guidance, Radar-feeding insights). Explicit allowlist, NOT this
// set: fields absent here are left untouched across a day boundary because
// they're genuinely day-independent (Wealth, weekly goals/review) — see the
// backend's identical-in-spirit DAY_INDEPENDENT_ALLOWLIST philosophy in
// routes/briefing.js. Kept as a deliberate enumeration (not "everything
// except an allowlist") so adding a new day-bound field to BriefingData is a
// visible, intentional decision here, not a silent gap.
const DAY_BOUND_FIELDS = [
  'date', 'quote', 'quoteInsight', 'dailyQuote', 'notionQuote', 'notionInsight',
  'notionPageTitle', 'notionText', 'relevantHighlight', 'wellbeingTheme',
  'calendar', 'workBusy', 'todayForecast', 'forecasts', 'todayCommandCenter',
  'recovery', 'effectiveWorkout', 'weather',
  'insights', 'crossContextInsights', 'healthInsights', 'healthComposites',
  'signals', 'alerts', 'urgentEmails', 'leverageActions', 'goalsWeekStart',
] as const;

function clearDayBoundFields(v: BriefingData): BriefingData {
  const cleared: Record<string, unknown> = { ...v };
  for (const key of DAY_BOUND_FIELDS) {
    const current = (v as unknown as Record<string, unknown>)[key];
    cleared[key] = Array.isArray(current) ? [] : typeof current === 'string' ? '' : null;
  }
  return cleared as unknown as BriefingData;
}

export function migrateV1Cache(v1: BriefingData | null, todayLocalDate: string): BriefingData | null {
  if (!v1) return null;
  if (!isUsableChiefBrief(v1.chiefBrief) || v1.chiefBriefPending) {
    return { ...v1, chiefBrief: null, chiefBriefPending: true, chiefBriefStale: false };
  }
  if (v1.localDate && v1.localDate !== todayLocalDate) {
    // Morning-notification lifecycle fix: a stale envelope from a PRIOR local
    // day must not carry forward a "Built Xh ago" timestamp alongside a
    // nulled chiefBrief — that exact pairing is the production bug ("Built
    // 23h ago" above an indefinite skeleton). snapshotAt/builtAt describe
    // WHEN this now-discarded content was cut; once the content itself is
    // being dropped for being a different day, its age has nothing left to
    // honestly describe until a fresh fetch lands.
    //
    // Cross-day lifecycle fix (defect 1): this used to null ONLY chiefBrief
    // while leaving quote/Notion/calendar/weather/forecasts/recovery from
    // the prior day fully intact — exactly the "still shows Tuesday's
    // Wisdom on Wednesday" production bug. Every day-bound field is cleared
    // the same way now; day-independent fields (Wealth, weekly goals/
    // review — anything not in DAY_BOUND_FIELDS) survive untouched.
    return clearDayBoundFields({
      ...v1, chiefBrief: null, chiefBriefPending: true, chiefBriefStale: false,
      snapshotAt: undefined, builtAt: undefined,
      dayState: 'previous_day', contentLocalDate: v1.localDate,
    });
  }
  return v1;
}
