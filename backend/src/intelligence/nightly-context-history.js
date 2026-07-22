// Canonical nightly-context-tag history — the fix for a production
// temporal-grounding bug: a late_meal tag logged TWO NIGHTS AGO ("occurred
// on 1 of the last 3 days") got restated by the Chief Brief as "the
// late-meal flag tonight can dent sleep" / "with a late meal on deck
// tonight" — a completed-night OBSERVATION rewritten as an invented FUTURE
// plan.
//
// Root cause: routes/context.js's self-report card (Magnesium, Alcohol,
// Late meal, ...) stores each tag as a 0/1 daily metric under the `context`
// domain, anchored to the WAKE date — a tag stored for local date D means
// "the night ending D", never "the night of D going forward" (see that
// file's header comment). routes/briefing.js used to read this data with an
// ad-hoc inline query feeding analyze.js's computeContextRecency(), whose
// output ("logged on K of the last N days") names no date at all — leaving
// the model free to read "recent" as "ongoing/upcoming". That block also
// only ran on the FULL build, so the scoped Chief Brief rebuild had no
// grounding for these tags whatsoever. And this data was never part of
// BrainSnapshot's canonical facts, so brain/claimValidator.js had no way to
// tell an occurred tag from a claimed plan.
//
// This module is the ONE canonical, dated, explicitly-historical projection
// of that data — registered in brain/registry.js, composed once by
// brain/snapshot.js, and consumed identically by the full build, the scoped
// rebuild, and claimValidator.js's checkTemporalFraming. It is deliberately
// NOT a replacement for analyze.js's computeContextRecency (that function
// has its own tests/consumers and stays exactly as-is) — this is a distinct,
// richer, EXPLICITLY-dated authority purpose-built to close the "historical
// observation read as a future plan" gap.
'use strict';

const { CONTEXT_TAGS } = require('./context-tags');
const { addDays, formatMonthDay } = require('../util/date');

const DEFAULT_WINDOW_DAYS = 3;

/** Pure: the local calendar-date string `n` days before/after `dateStr`.
 *  Anchors at noon UTC (matches routes/context.js's own anchoring) so whole-
 *  day arithmetic never crosses a boundary from a DST shift — this is pure
 *  calendar-day math, not wall-clock math, so it is DST-safe by construction. */
function shiftLocalDateStr(dateStr, n) {
  const anchor = new Date(`${dateStr}T12:00:00Z`);
  return addDays(anchor, n).toLocaleDateString('en-CA', { timeZone: 'UTC' });
}

/** "last night" | "N nights ago" — the age-in-completed-nights phrasing the
 *  temporal contract requires; ageNights=0 (today's wake-date) is always
 *  "last night", NEVER "tonight". */
function ageNightsPhrase(ageNights) {
  if (ageNights <= 0) return 'last night';
  if (ageNights === 1) return '1 night ago';
  return `${ageNights} nights ago`;
}

/** "last night" | "the night ending <Month Day> (<N> nights ago)" — the full
 *  dated-occurrence phrase. Never says "tonight" for a today-wake-date
 *  occurrence — that would be exactly the bug this module exists to fix. */
function nightEndingPhrase(nightEndingLocalDate, ageNights) {
  if (ageNights <= 0) return 'last night';
  return `the night ending ${formatMonthDay(`${nightEndingLocalDate}T12:00:00Z`, 'UTC')} (${ageNightsPhrase(ageNights)})`;
}

/**
 * Pure: project raw per-tag/day series (metrics domain 'context', keyed
 * 'context:<tag>', the same {day, value} shape analyze.js's
 * computeContextRecency accepts) into the canonical, per-occurrence,
 * explicitly-historical structure.
 *
 * @param {Record<string, {day: string|Date, value: any}[]>} seriesByKey
 * @param {{ windowDays?: number, today?: string, provenance?: string }} [opts]
 * @returns {Array<{tag, label, windowDays, loggedDays, streakDays,
 *   isConsecutiveStreak, occurrences, latestOccurrence, summary}>}
 */
function buildNightlyContextHistory(seriesByKey, opts = {}) {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const todayLocal = opts.today || new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/New_York' });
  const provenance = opts.provenance || 'self_report';

  const tags = [];
  for (const t of CONTEXT_TAGS) {
    const key = `context:${t.key}`;
    const series = seriesByKey[key];
    if (!series || !series.length) continue;

    // r.day may be a Postgres DATE hydrated as a JS Date (String(date) gives
    // a locale-formatted string, NOT "YYYY-MM-DD") or already a plain string
    // — normalize via toISOString() for a real Date, matching analyze.js's
    // own toDayKey helper exactly, so both call sites agree on day-keying.
    const byDay = new Map();
    for (const r of series) {
      const dayKey = (r.day instanceof Date ? r.day.toISOString() : String(r.day)).slice(0, 10);
      byDay.set(dayKey, Number(r.value));
    }

    // Occurrences within the window, most-recent-first. Only POSITIVE
    // (value >= 0.5) occurrences are ever emitted — absence (no row, or an
    // explicit 0) never becomes a "did not happen" claim here; see the
    // module header. Each occurrence carries every field the temporal
    // contract requires: concept, status (always 'occurred' — this
    // structure exists ONLY for completed-night observations), the exact
    // night-ending date, its age in completed nights, provenance, and an
    // explicit isCurrentOrFuturePlan:false so a consumer never has to infer
    // "not a plan" from absence of a plan field.
    const occurrences = [];
    for (let i = 0; i < windowDays; i++) {
      const dayStr = shiftLocalDateStr(todayLocal, -i);
      if ((byDay.get(dayStr) ?? 0) >= 0.5) {
        occurrences.push({
          concept: t.key,
          status: 'occurred',
          nightEndingLocalDate: dayStr,
          ageNights: i,
          provenance,
          isCurrentOrFuturePlan: false,
        });
      }
    }
    if (!occurrences.length) continue;

    // Trailing consecutive-night run, counting back from today (ageNights=0)
    // until the first gap — same rule as analyze.js's computeContextRecency.
    let streakDays = 0;
    for (let i = 0; i < windowDays; i++) {
      const dayStr = shiftLocalDateStr(todayLocal, -i);
      if ((byDay.get(dayStr) ?? 0) >= 0.5) streakDays++;
      else break;
    }
    const loggedDays = occurrences.length;
    const isConsecutiveStreak = streakDays >= 2 && streakDays === loggedDays;
    const latest = occurrences[0]; // ageNights ascending from the loop above → index 0 is most recent
    const latestPhrase = nightEndingPhrase(latest.nightEndingLocalDate, latest.ageNights);

    const summary = isConsecutiveStreak
      ? `${t.label}: occurred ${streakDays} consecutive nights, most recently ${latestPhrase}. Historical observation only — not evidence of a plan tonight.`
      : `${t.label}: occurred on ${loggedDays} of the last ${windowDays} completed nights; latest occurrence was ${latestPhrase}. Historical observation only — not evidence of a plan tonight.`;

    tags.push({
      tag: t.key,
      label: t.label,
      windowDays,
      loggedDays,
      streakDays,
      isConsecutiveStreak,
      occurrences,
      latestOccurrence: { nightEndingLocalDate: latest.nightEndingLocalDate, ageNights: latest.ageNights },
      summary,
    });
  }
  return tags;
}

/**
 * The DB-reading authority — brain/registry.js's `nightlyContextHistory`
 * field authority points here; brain/snapshot.js's buildBrainSnapshot calls
 * this once per snapshot; the scoped Chief Brief rebuild (which doesn't
 * build a full snapshot) calls it directly, exactly the same way it already
 * calls intelligence/context-resolver.js's resolveContext() — so both build
 * paths always read the identical canonical facts.
 *
 * @param {{ tz?: string, asOf?: Date, windowDays?: number }} [opts]
 */
async function computeNightlyContextHistory({ tz = process.env.TZ || 'America/New_York', asOf = new Date(), windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const db = require('../db');
  const todayLocal = asOf.toLocaleDateString('en-CA', { timeZone: tz });
  const from = new Date(asOf.getTime() - (windowDays + 1) * 24 * 60 * 60 * 1000);
  const { rows } = await db.query(
    `SELECT metric, (ts AT TIME ZONE $2)::date AS day, avg(value) AS value
       FROM metrics WHERE domain = 'context' AND ts >= $1
       GROUP BY metric, day`,
    [from, tz]
  );
  const seriesByKey = {};
  for (const r of rows) {
    const key = `context:${r.metric}`;
    (seriesByKey[key] || (seriesByKey[key] = [])).push({ day: r.day, value: Number(r.value) });
  }
  return buildNightlyContextHistory(seriesByKey, { today: todayLocal, windowDays });
}

/** Render the canonical history as the Chief Brief prompt's RECENT CONTEXT
 *  TAGS block. Pure. Empty string when there's nothing to report (the block
 *  is simply omitted, same as every other optional prompt section). */
function renderNightlyContextHistoryPrompt(history) {
  if (!history || !history.length) return '';
  return 'RECENT CONTEXT TAGS (factual, DATED historical occurrences — cite these exact counts/dates; NEVER convert '
    + 'one into a "tonight"/"today" plan, a percentage-above-baseline, or a different streak length. A tag whose latest '
    + 'occurrence is on today\'s wake-date is "last night" — NEVER "tonight". Absence of a tag here means unknown, not '
    + 'a confirmed "did not happen"):\n'
    + history.map((h) => `- ${h.summary}`).join('\n');
}

module.exports = {
  buildNightlyContextHistory,
  computeNightlyContextHistory,
  renderNightlyContextHistoryPrompt,
  DEFAULT_WINDOW_DAYS,
};
