// Persisted briefings/reviews (daily | weekly | quarterly narratives).
const { query } = require('../db');

// briefings.id is a UUID column (see migrations/001_init.sql). A malformed
// value (e.g. GET /briefing/weekly-review?id=999999999 — an array index or
// truncated id from a stale client) must read as "not found", not a raw
// Postgres "invalid input syntax for type uuid" error surfacing as a 500 —
// exactly the "never substitute, never 500, just 404" contract the weekly-
// review route's own tests require.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function saveBriefing({ kind = 'daily', content, periodStart = null, periodEnd = null }) {
  const { rows } = await query(
    `INSERT INTO briefings (kind, content, period_start, period_end)
     VALUES ($1, $2, $3, $4) RETURNING id, generated_at`,
    [kind, content, periodStart, periodEnd]
  );
  return rows[0] ?? null;
}

/**
 * Blank the chief brief's openQuestion in ALL of today's cached daily builds.
 * Called when the user answers it: the question was asked by a build that's
 * now a stored cache, so component state alone can't retire it — a tab switch
 * remounts the card from this cache and the already-answered question pops
 * back up. Blanking at the source means every refetch/remount/app-restart
 * agrees it's been dealt with. (Multiple builds per day each insert a row, so
 * update every row from today, not just the newest.)
 *
 * `db` defaults to the pooled `query` but accepts an injected transaction
 * client (see db/index.js's withTransaction) — POST /briefing/context runs
 * this in the SAME transaction as the answered-question ledger write and its
 * explanatory annotation, so a failure here rolls back the whole answer
 * instead of leaving the question durably suppressed while a stale cached
 * build still shows it (or vice versa).
 */
async function blankTodaysOpenQuestion(tz = process.env.TZ || 'America/New_York', db = query) {
  const { rowCount } = await db(
    `UPDATE briefings
        SET content = jsonb_set(content, '{chiefBrief,openQuestion}', '""'::jsonb)
      WHERE kind = 'daily'
        AND (generated_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
        AND content ? 'chiefBrief'
        AND COALESCE(content->'chiefBrief'->>'openQuestion', '') <> ''`,
    [tz]
  );
  return rowCount;
}

async function latestBriefing(kind = 'weekly') {
  const { rows } = await query(
    `SELECT * FROM briefings WHERE kind = $1 ORDER BY generated_at DESC LIMIT 1`,
    [kind]
  );
  return rows[0] ?? null;
}

/**
 * Pure: does this ChiefBrief object have the minimum shape to actually show
 * something (not itself a QUALITY judgment — that's chiefBriefQuality; this
 * only asks "is there a real object here, not a null/stub")?
 */
function isStructurallyUsableChiefBrief(cb) {
  return Boolean(cb && typeof cb === 'object' && (cb.synthesis || cb.action || cb.risk || cb.move));
}

/**
 * Is a stored daily-briefing row's content eligible to be treated as
 * "the last-known-good Chief Brief"? Structurally usable content, and not
 * explicitly flagged pending (chiefBriefPending: true means the row's own
 * build/repair attempt came back empty even if chiefBrief is somehow
 * non-null — belt & suspenders).
 *
 * Deliberately does NOT require content.chiefBriefQuality?.status === 'fresh'.
 * That field describes THIS row's OWN build/repair ATTEMPT, not whether its
 * chiefBrief content is fit to display — a row that carried forward an
 * earlier fresh brief because its OWN attempt was degraded
 * (chiefBriefStale: true) has a degraded chiefBriefQuality but a perfectly
 * good chiefBrief. Treating quality as the bar here is exactly the bug that
 * let a SECOND consecutive failed repair delete an already-good,
 * already-carried-forward brief (see routes/briefing.js's
 * performScopedChiefBriefRebuild and the Chief Brief regression fix).
 */
function isPublishableRow(content) {
  return Boolean(content) && !content.chiefBriefPending && isStructurallyUsableChiefBrief(content.chiefBrief);
}

/**
 * The newest SAME-LOCAL-DAY daily row with a structurally usable, non-pending
 * Chief Brief — the read-time safety net for corrupted/poisoned days. Does
 * NOT simply trust the newest daily row (latestBriefing('daily')): a
 * degraded/failed build or repair attempt can insert a row too (or, for a
 * row from before this fix, could have left one with chiefBrief: null), so
 * this scans backward through a bounded window of same-day rows for the
 * newest one that's actually publishable.
 *
 * `limit` defaults generously (200, not the ~10-40 rows the other helpers in
 * this file scan) specifically to recover ALREADY-poisoned production days:
 * before this fix shipped, a run of consecutive failed automatic repairs
 * could have inserted many degraded/null rows in a single day, each one
 * burying the last good row one row deeper.
 */
async function latestPublishableDailyForLocalDay(localDay, { tz = process.env.TZ || 'America/New_York', limit = 200 } = {}) {
  if (!localDay) return null;
  const rows = await listBriefings({ kind: 'daily', limit });
  const dayOf = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
  for (const r of rows) {
    if (dayOf(r.generated_at) !== localDay) continue;
    if (isPublishableRow(r.content)) return r;
  }
  return null;
}

/**
 * The one shared "what should we carry forward when THIS attempt isn't
 * fresh?" resolver — used identically by every caller (cache-hit serve,
 * full build, scoped rebuild) so "what counts as last-known-good" can never
 * drift between them. Prefers `prior` itself when it's already publishable
 * (the common case — no extra query); only falls back to the bounded
 * backward scan when `prior` itself isn't currently publishable (a
 * corrupted/pending row, or a row mid-repair).
 *
 * Same-local-day only (`prior`'s own local day) — a previous-day Chief Brief
 * must never masquerade as today's.
 *
 * @returns {Promise<{chiefBrief:object, morningFocus:string, goalsWeekStart:string|null, builtAt:string|null, snapshotId:string|null, localDate:string}|null>}
 */
async function resolveLastGoodChiefBrief(prior, { tz = process.env.TZ || 'America/New_York' } = {}) {
  if (!prior?.generated_at) return null;
  // Scoped to TODAY's actual current local day — NOT merely "the same day
  // `prior` itself was built on". `prior` is usually today's own latest row,
  // but when it isn't (the very first request after midnight, before
  // today's own build has run), trusting prior's own day label would carry
  // an honest-but-PREVIOUS-day brief forward as if it were today's — the
  // exact cross-day masquerade requirement #9 forbids.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const priorDay = new Date(prior.generated_at).toLocaleDateString('en-CA', { timeZone: tz });
  const shape = (content) => ({
    chiefBrief: content.chiefBrief,
    morningFocus: content.morningFocus || '',
    goalsWeekStart: content.goalsWeekStart ?? null,
    builtAt: content.builtAt ?? null,
    snapshotId: content.snapshotId ?? null,
    localDate: today,
    // The carried-forward row's own publish tier (brain/publishTier.js) —
    // legacy rows that predate this contract fall back to deriving it from
    // their chiefBriefQuality at the call site (never assumed premium_fresh
    // here, to keep this module free of a require cycle on brain/publishTier).
    publishTier: content.publishTier ?? null,
    chiefBriefQuality: content.chiefBriefQuality ?? null,
  });
  if (priorDay === today && isPublishableRow(prior.content)) return shape(prior.content);
  const row = await latestPublishableDailyForLocalDay(today, { tz });
  return row ? shape(row.content) : null;
}

async function listBriefings({ kind = 'weekly', limit = 4 } = {}) {
  const { rows } = await query(
    `SELECT id, kind, generated_at, period_start, period_end, content FROM briefings
     WHERE kind = $1 ORDER BY generated_at DESC LIMIT $2`,
    [kind, limit]
  );
  return rows;
}

/**
 * The EXACT briefing row carrying this snapshotId, or null. A direct,
 * bounded (LIMIT 1) lookup — not a paginated/historical browse — so a
 * caller that needs to serve or narrate the SPECIFIC persisted build a
 * client is displaying (mobile's BriefingData.snapshotId) can find it
 * regardless of which local day it was generated on, without either
 * fetching unbounded history or silently substituting a different build
 * (see routes/audio.js's snapshotId handling — the bug this fixes: a stale
 * cached mobile screen showing yesterday's briefing got a 404 before TTS
 * was ever attempted, because the old lookup filtered to TODAY's rows
 * before ever checking snapshotId).
 */
async function findBySnapshotId(kind, snapshotId) {
  if (!snapshotId) return null;
  const { rows } = await query(
    `SELECT id, kind, generated_at, period_start, period_end, content FROM briefings
      WHERE kind = $1 AND content->>'snapshotId' = $2
      ORDER BY generated_at DESC LIMIT 1`,
    [kind, snapshotId]
  );
  return rows[0] ?? null;
}

/**
 * The EXACT briefing row by primary key, or null. The id-based counterpart to
 * findBySnapshotId — used by publishBriefingDraft's post-save read-back
 * verification (morning-notification lifecycle fix): after INSERTing a row,
 * prove it is actually retrievable by its own id before treating publication
 * as real, rather than trusting the in-memory draft/INSERT result as its own
 * proof.
 */
async function findById(id) {
  if (!id || !UUID_RE.test(String(id))) return null;
  const { rows } = await query(
    `SELECT id, kind, generated_at, period_start, period_end, content FROM briefings WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * The weekly-review row whose period_start matches `weekStart` exactly, or
 * null. Used by the canonical openWeeklyReview mobile action's weekStart
 * fallback path (identity by stable ID is preferred; this covers a cached
 * client that only ever stored the week it was showing, or a push payload
 * from before `reviewId` existed). If a week was regenerated more than once,
 * the most recent run wins — the same "latest per period" rule
 * listBriefings/latestBriefing already use elsewhere.
 */
async function findWeeklyReviewByWeekStart(weekStart) {
  if (!weekStart) return null;
  const { rows } = await query(
    `SELECT id, kind, generated_at, period_start, period_end, content FROM briefings
      WHERE kind = 'weekly' AND period_start::date = $1::date
      ORDER BY generated_at DESC LIMIT 1`,
    [weekStart]
  );
  return rows[0] ?? null;
}

/**
 * The last `days` distinct CALENDAR days' chief-of-staff briefs, most recent
 * first, excluding today. Multiple manual rebuilds in one day each insert their
 * own row (no upsert), so this dedupes to the LATEST build per local day — the
 * version the user actually saw most. Used to give the brief-writer concrete
 * "here's what you said the last few mornings" grounding so it can recognize
 * when it's about to repeat itself instead of re-explaining a stale story fresh
 * every day.
 */
async function recentDailyBriefOpeners(days = 3) {
  const rows = await listBriefings({ kind: 'daily', limit: 40 });
  const tz = process.env.TZ || 'America/New_York';
  const localDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
  const todayLocal = localDay(new Date());
  const byDay = new Map(); // rows are DESC by generated_at, so first hit per day = that day's LAST build
  for (const r of rows) {
    const day = localDay(r.generated_at);
    if (day === todayLocal || byDay.has(day)) continue;
    const cb = r.content?.chiefBrief;
    // tomorrowForecast: that day's prediction for the NEXT day (i.e. potentially
    // today), carried alongside the opener text so a caller can check whether
    // the forecast held — see computeTodayForecast's `tomorrow` field.
    const tomorrowForecast = r.content?.todayForecast?.tomorrow ?? null;
    if (cb || tomorrowForecast) byDay.set(day, { day, ...(cb || {}), tomorrowForecast });
  }
  return [...byDay.values()].slice(0, days);
}

/**
 * TODAY's DISPLAYED chief-of-staff brief — the newest same-day row that's
 * actually publishable (latestPublishableDailyForLocalDay), not simply the
 * newest same-day database row. Lets the evening brief grade the morning's
 * ACTUAL plan — "this morning I asked for X; here's what actually
 * happened" — using the same brief the user was shown, not a later failed/
 * pending/thin repair attempt that never displayed. Returns null before any
 * publishable build exists yet today.
 */
async function todaysMorningBrief(tz = process.env.TZ || 'America/New_York') {
  const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const row = await latestPublishableDailyForLocalDay(todayLocal, { tz });
  return row?.content?.chiefBrief ?? null;
}

module.exports = {
  saveBriefing, latestBriefing, listBriefings, findBySnapshotId, findById, findWeeklyReviewByWeekStart,
  recentDailyBriefOpeners, todaysMorningBrief, blankTodaysOpenQuestion,
  isStructurallyUsableChiefBrief, isPublishableRow, latestPublishableDailyForLocalDay, resolveLastGoodChiefBrief,
};
