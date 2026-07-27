// Persisted briefings/reviews (daily | weekly | quarterly narratives).
const { query } = require('../db');

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
 * TODAY's chief-of-staff brief (latest build this local day), or null before
 * the morning build exists. Lets the evening brief grade the morning's plan —
 * "this morning I asked for X; here's what actually happened."
 */
async function todaysMorningBrief() {
  const rows = await listBriefings({ kind: 'daily', limit: 10 });
  const tz = process.env.TZ || 'America/New_York';
  const localDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
  const todayLocal = localDay(new Date());
  for (const r of rows) {
    if (localDay(r.generated_at) === todayLocal) return r.content?.chiefBrief ?? null;
  }
  return null;
}

module.exports = {
  saveBriefing, latestBriefing, listBriefings, findBySnapshotId, recentDailyBriefOpeners, todaysMorningBrief, blankTodaysOpenQuestion,
  isStructurallyUsableChiefBrief, isPublishableRow, latestPublishableDailyForLocalDay, resolveLastGoodChiefBrief,
};
