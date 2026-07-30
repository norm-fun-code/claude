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

// Cross-day lifecycle hardening pass — DAY-INDEPENDENT allowlist (the
// INVERSE of the old DAY_BOUND_FIELDS enumeration). Rather than hand-
// maintaining "what's day-bound" (an incomplete list is exactly how
// `workout` escaped the old enumeration and kept leaking across midnight),
// this hand-maintains "what's SAFE to carry across a day boundary" —
// everything else on BriefingData is treated as day-bound content and
// cleared by default. A newly added field to BriefingData is therefore
// safe-by-default (cleared until someone deliberately reviews it and adds it
// here), never leaked-by-default.
const DAY_INDEPENDENT_FIELDS = new Set<string>([
  // Wealth — genuinely day-independent (net worth / discretionary spend
  // don't reset at local midnight the way Wisdom/Today/recovery do).
  'wealth', 'wealthLanding', 'wealthLandingStale', 'wealthInsights', 'financeSummary',
  // Weekly-cadence data — bound to a week, not a day.
  'weeklyGoals', 'weeklyReview',
  'experiments',
  // Response/version bookkeeping — not day-bound CONTENT. The day-identity
  // subset of these (localDate, dayState, contentLocalDate, snapshotAt,
  // builtAt) is always explicitly re-set by the caller right after
  // sanitizing, so leaving them in the allowlist just avoids the generic
  // clear pass fighting that explicit override.
  'localDate', 'timezone', 'currentLocalDate', 'contentLocalDate', 'dayState',
  'morningReadinessState', 'morningReadinessReason', 'recoveryBuildId',
  'snapshotId', 'snapshotVersion', 'fieldsBuiltAt', 'fieldVersions',
  'cached', 'cachedAgeMin', 'stale', 'errors',
  // Chief Brief identity/attempt bookkeeping — every caller here always
  // overwrites these explicitly too (chiefBrief: null, chiefBriefPending:
  // true, ...); listed so the generic pass doesn't clear them to a
  // non-standard empty shape before that explicit override lands.
  'chiefBrief', 'chiefBriefStale', 'chiefBriefPending', 'chiefBriefQuality', 'publishTier',
  'chiefBriefProvenance', 'chiefBriefAttempt', 'morningFocus',
  'goalsWeekStart', 'chiefBriefGoalsStale',
]);

/** Generic day-boundary sanitizer: every field NOT in DAY_INDEPENDENT_FIELDS
 *  is cleared to its type-appropriate empty value (array -> [], string ->
 *  '', anything else -> null). This is THE ONE day-bound projection every
 *  caller in this file routes through, so Today, Brief, Radar, recovery,
 *  workout, effectiveWorkout, forecasts, calendar, weather, and daily alerts
 *  are all cleared identically, by construction, rather than by a
 *  hand-maintained per-field list that can silently miss one. */
function sanitizeDayBoundFields(v: BriefingData): BriefingData {
  const cleared: Record<string, unknown> = {};
  const src = v as unknown as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    const current = src[key];
    if (DAY_INDEPENDENT_FIELDS.has(key)) { cleared[key] = current; continue; }
    cleared[key] = Array.isArray(current) ? [] : typeof current === 'string' ? '' : null;
  }
  return cleared as unknown as BriefingData;
}

/** True when `data` describes a LOCAL day other than `todayLocalDate` — the
 *  one day-identity check that must run BEFORE any Chief-Brief-usability
 *  branching (cross-day lifecycle hardening pass, defect 1: checking
 *  usability/pending FIRST let a `{chiefBrief:null, chiefBriefPending:true}`
 *  prior-day payload short-circuit past this check entirely). A missing
 *  `localDate` (a very old cache, predating the Context Understanding Layer)
 *  is treated as "can't tell, leave alone" — the existing, deliberate
 *  fail-open posture for that specific legacy-shape case, unchanged here. */
function isPriorDay(data: BriefingData, todayLocalDate: string): boolean {
  return Boolean(data.localDate) && data.localDate !== todayLocalDate;
}

/** True when `incoming` is explicitly flagged by the SERVER as describing a
 *  day other than the live day at response time. Primary signal is
 *  `dayState` (backend routes/briefing.js always computes `currentLocalDate`
 *  live and derives `dayState` by comparing it against the content's own
 *  day, on every response — cache-hit or fresh-build). Falls back to
 *  comparing `localDate` against `currentLocalDate` directly when `dayState`
 *  itself is absent (an old cached response shape from before every
 *  response carried it). Deliberately never consults a client-side clock —
 *  this decision can never disagree with what the server just said about
 *  its own response. */
function isIncomingPriorDay(incoming: BriefingData): boolean {
  if (incoming.dayState) return incoming.dayState === 'previous_day';
  return Boolean(incoming.localDate) && Boolean(incoming.currentLocalDate) && incoming.localDate !== incoming.currentLocalDate;
}

/**
 * The one merge point for every incoming briefing payload.
 *
 * - Day identity is resolved FIRST (cross-day lifecycle hardening pass,
 *   defect 2): a response the server itself flagged `dayState:
 *   'previous_day'` is sanitized (every day-bound field cleared) before any
 *   Chief-Brief-usability branching runs — it can never repopulate stale
 *   fields just because its (previous day's) Chief Brief happens to look
 *   usable and non-pending.
 * - Otherwise: when `incoming` carries a publishable Chief Brief (or there's
 *   no existing last-good card to protect), `incoming` is authoritative
 *   as-is.
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
  if (isIncomingPriorDay(incoming)) {
    // Our current in-memory state may already describe the SAME live day
    // the server just reported (e.g. a scoped chief-brief-retry response
    // raced a fuller update that already landed) — that existing state is
    // strictly better information than a previous_day response, so keep it
    // outright rather than downgrading to a freshly-sanitized (blanker)
    // previous_day payload.
    if (existing && incoming.currentLocalDate && existing.localDate === incoming.currentLocalDate) {
      return existing;
    }
    return withWealthLandingProtected(sanitizeDayBoundFields(incoming), incoming, existing);
  }
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
    publishTier: lastGood.publishTier ?? null,
  };
  return withWealthLandingProtected(merged, incoming, existing);
}

/**
 * Cache migration (v1 -> v2, and every subsequent cold-launch cache load —
 * despite the name this runs on every load, not just a one-time v1->v2
 * migration): recover a structurally valid same-day Chief Brief from an
 * already-poisoned cache (one written by a pre-fix client, which could have
 * persisted `chiefBrief: null` over a previously good card), AND sanitize
 * every day-bound field when the cached payload is from a PRIOR local day.
 *
 * - Day identity is resolved FIRST (cross-day lifecycle hardening pass,
 *   defect 1) — a cached payload from a prior local day is always
 *   sanitized via `sanitizeDayBoundFields`, regardless of what its own
 *   chiefBrief/chiefBriefPending happen to look like. This is what makes a
 *   `{localDate: yesterday, chiefBrief: null, chiefBriefPending: true, ...
 *   rest of yesterday's fields still populated}` cache correctly clear
 *   everything instead of short-circuiting on the "unusable/pending"
 *   check before the day check ever ran.
 * - Only once the cached payload is confirmed to be describing TODAY does
 *   the (day-independent) "is the cached Chief Brief itself usable" check
 *   apply.
 */
export function migrateV1Cache(v1: BriefingData | null, todayLocalDate: string): BriefingData | null {
  if (!v1) return null;
  if (isPriorDay(v1, todayLocalDate)) {
    // Morning-notification lifecycle fix: a stale envelope from a PRIOR local
    // day must not carry forward a "Built Xh ago" timestamp alongside a
    // nulled chiefBrief — that exact pairing is the production bug ("Built
    // 23h ago" above an indefinite skeleton). snapshotAt/builtAt describe
    // WHEN this now-discarded content was cut; once the content itself is
    // being dropped for being a different day, its age has nothing left to
    // honestly describe until a fresh fetch lands.
    return {
      ...sanitizeDayBoundFields(v1),
      chiefBrief: null, chiefBriefPending: true, chiefBriefStale: false,
      snapshotAt: undefined, builtAt: undefined,
      dayState: 'previous_day', contentLocalDate: v1.localDate,
    };
  }
  if (!isUsableChiefBrief(v1.chiefBrief) || v1.chiefBriefPending) {
    return { ...v1, chiefBrief: null, chiefBriefPending: true, chiefBriefStale: false };
  }
  return v1;
}
