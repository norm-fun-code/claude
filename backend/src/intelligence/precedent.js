// PRECEDENT — "you've been here before."
//
// Every other intelligence module in this codebase answers "what is true
// right now" (recovery, forecast, anomalies, wealth posture). None of them
// answer the question a person actually asks at 7am: *I have felt like this
// before — what happened the last times, and what did I do that made it
// better or worse?*
//
// That question is only answerable because of the decision the architecture
// doc calls the foundation ("persistence first"): the spine has a year of
// one-row-per-observation history in `metrics`. This module turns that
// history into precedent — the days most like today, what was actually done
// on them, and what actually happened next. It is retrieval over the user's
// own life, not a model's opinion about it.
//
// TRUTH CONTRACT (the same bar the rest of the codebase holds itself to):
//
//   * Nothing here is generated. Every number traces to real metric rows,
//     and every precedent carries its real calendar date so the claim can be
//     checked by hand.
//   * Correlation is never narrated as causation. The output reports what
//     happened after similar mornings; it never says a lever *caused* an
//     outcome and never tells the user what to do.
//   * Insufficient evidence returns null, never a hedged claim. A precedent
//     set that is too small, too dissimilar, or too lopsided to support a
//     comparison produces NO card rather than a weak one. This is the same
//     principle as findRiskEvidence's independent gate in
//     brain/todayCommandCenter.js: the surface exists only when independently
//     computed evidence justifies it.
//   * Baselines are CAUSAL. A day's z-scores are computed against only the
//     days BEFORE it, so a precedent from June is scored the way it would
//     have been scored in June — never with hindsight from data that had not
//     happened yet.
//
// The pure functions below hold all the logic and all the gates; the single
// IO wrapper (computePrecedent) only reads the spine and calls them.
'use strict';

/**
 * A morning's state vector. Each entry is a canonical (domain:metric) key
 * already present in the spine — this module introduces no new metric and
 * no new ingestion. `weight` is the feature's share of the similarity
 * judgement; `kind` selects the dissimilarity function (see gowerDistance).
 *
 * Only overnight/priors are included, deliberately: the card is for the
 * decision made in the MORNING, so it may only use what is actually known
 * by then. Same-day mood/energy/focus come from the afternoon check-in and
 * would be leakage from the future of the very day being described.
 */
const FEATURE_SPEC = [
  { key: 'health:hrv', label: 'HRV', weight: 1.0, kind: 'numeric' },
  { key: 'health:resting_hr', label: 'Resting HR', weight: 1.0, kind: 'numeric' },
  { key: 'health:sleep_hours', label: 'Sleep', weight: 0.9, kind: 'numeric' },
  { key: 'health:sleep_score', label: 'Sleep score', weight: 0.7, kind: 'numeric' },
  { key: 'health:deep_sleep_hours', label: 'Deep sleep', weight: 0.5, kind: 'numeric' },
  { key: 'health:respiratory_rate', label: 'Breathing rate', weight: 0.4, kind: 'numeric' },
  // Yesterday's load — the state you carry INTO today. Built by the IO layer
  // by shifting health:active_energy one day forward, so it is genuinely a
  // prior observation rather than same-day leakage.
  { key: 'prev:active_energy', label: 'Yesterday’s load', weight: 0.6, kind: 'numeric' },
];

// --- Gates. Each one exists to stop a specific way of being wrong. --------

/** Trailing days used to z-score one observation. Long enough to be a real
 *  personal baseline, short enough to follow a genuine seasonal shift. */
const BASELINE_DAYS = 28;
/** Fewer observations than this in the trailing window and the feature is
 *  simply unavailable for that day — never imputed, never mean-filled. */
const MIN_BASELINE_OBS = 10;
/** A candidate day must share at least this many features with today.
 *  Two days that overlap on one sparse metric are not "similar", they are
 *  uncomparable. */
const MIN_SHARED_FEATURES = 3;
/** Gower similarity (1 - distance) a day must reach to count as a precedent.
 *  Set so that a precedent differs from today by well under 1σ on the
 *  features they share. */
const MIN_SIMILARITY = 0.8;
/** Below this many precedents there is no pattern, only anecdote. */
const MIN_PRECEDENTS = 5;
/** Each arm of the "what you did" comparison needs its own support. */
const MIN_ARM = 3;
/** Recovery points. A split smaller than this is noise dressed as a finding,
 *  so the comparison is withheld and only the precedent set is shown. */
const MIN_SPLIT_GAP = 3;
/** Precedents are ranked by similarity; only this many are ever reported. */
const MAX_PRECEDENTS = 12;
/** z-difference treated as "completely dissimilar" on one numeric feature.
 *  4 == two days sitting 2σ either side of the baseline. */
const Z_RANGE = 4;

// --- Small numeric helpers (pure) ----------------------------------------

function mean(xs) {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Calendar arithmetic on YYYY-MM-DD. No timezone involved — the string
 *  already names one specific local day (same convention as
 *  weeklyLedger.addDaysToDateStr). */
function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// --- Pure core -----------------------------------------------------------

/**
 * Causal z-scores for one metric series.
 *
 * For each day, the mean/sd come from the `baselineDays` calendar days
 * strictly BEFORE it. A day whose trailing window holds fewer than
 * `minObs` observations, or whose baseline has no spread, yields no z —
 * the feature is absent for that day rather than guessed at.
 *
 * @param {Record<string, number>} byDay YYYY-MM-DD -> value.
 * @returns {Record<string, number>} YYYY-MM-DD -> z-score.
 */
function causalZScores(byDay, { baselineDays = BASELINE_DAYS, minObs = MIN_BASELINE_OBS } = {}) {
  const days = Object.keys(byDay || {}).filter((d) => Number.isFinite(byDay[d])).sort();
  const out = {};
  for (const day of days) {
    const windowStart = addDays(day, -baselineDays);
    const prior = [];
    for (const other of days) {
      if (other >= day) break; // sorted — everything after this is same-day or later
      if (other >= windowStart) prior.push(byDay[other]);
    }
    if (prior.length < minObs) continue;
    const sd = stdev(prior);
    if (sd == null || sd === 0) continue;
    out[day] = (byDay[day] - mean(prior)) / sd;
  }
  return out;
}

/**
 * Gower dissimilarity between two state vectors.
 *
 * Gower is the right choice here because the vectors are RAGGED: any given
 * morning may be missing a sleep score, a breathing rate, or yesterday's
 * load. Gower handles that natively — a feature absent from either day is
 * dropped from both the numerator and the denominator, so the result stays
 * a proper 0..1 dissimilarity over whatever the two days genuinely share,
 * instead of quietly scoring a missing value as agreement.
 *
 * @returns {{distance:number, sharedCount:number, sharedWeight:number}|null}
 *   null when the two vectors share no weighted feature at all.
 */
function gowerDistance(a, b, spec = FEATURE_SPEC) {
  let num = 0;
  let den = 0;
  let sharedCount = 0;
  for (const f of spec) {
    const av = a?.[f.key];
    const bv = b?.[f.key];
    if (av == null || bv == null) continue;
    let d;
    if (f.kind === 'binary') {
      d = av === bv ? 0 : 1;
    } else {
      if (!Number.isFinite(av) || !Number.isFinite(bv)) continue;
      d = Math.min(1, Math.abs(av - bv) / Z_RANGE);
    }
    num += f.weight * d;
    den += f.weight;
    sharedCount += 1;
  }
  if (den === 0) return null;
  return { distance: num / den, sharedCount, sharedWeight: den };
}

/**
 * Rank past days by similarity to today, keeping only those that clear both
 * the comparability gate (enough shared features) and the similarity gate.
 *
 * @param {object} input
 * @param {Record<string, number>} input.todayVector
 * @param {Record<string, Record<string, number>>} input.historyVectors day -> vector.
 * @returns {Array<{day:string, similarity:number, sharedCount:number}>}
 *   descending by similarity, capped at `limit`.
 */
function rankPrecedents({
  todayVector,
  historyVectors,
  spec = FEATURE_SPEC,
  minShared = MIN_SHARED_FEATURES,
  minSimilarity = MIN_SIMILARITY,
  limit = MAX_PRECEDENTS,
} = {}) {
  const scored = [];
  for (const [day, vec] of Object.entries(historyVectors || {})) {
    const g = gowerDistance(todayVector, vec, spec);
    if (!g) continue;
    if (g.sharedCount < minShared) continue;
    const similarity = 1 - g.distance;
    if (similarity < minSimilarity) continue;
    scored.push({ day, similarity, sharedCount: g.sharedCount });
  }
  // Ties broken by recency: a more recent precedent describes a more current
  // version of the person, which is the more useful one to surface.
  scored.sort((x, y) => (y.similarity - x.similarity) || (y.day < x.day ? -1 : 1));
  return scored.slice(0, limit);
}

/**
 * Split precedents by what was actually DONE on them and compare what
 * happened next.
 *
 * The lever is measured, not inferred: `leverByDay` is the day's own active
 * energy (a dense, device-recorded metric), split at the MEDIAN of this
 * precedent set — so "lighter" and "harder" mean lighter and harder *for
 * these particular days*, not against some global notion of a hard day.
 * The outcome is next-day recovery movement.
 *
 * Returns null — deliberately, rather than a hedge — when either arm is too
 * small to support a comparison, when the split is degenerate (every day at
 * the same load), or when the gap between the arms is inside the noise
 * floor. A withheld comparison still leaves the precedent set itself, which
 * is useful on its own.
 *
 * @param {Array<{day:string}>} precedents
 * @param {object} opts
 * @param {Record<string, number>} opts.leverByDay day -> active energy.
 * @param {Record<string, number>} opts.outcomeByDay day -> next-day recovery delta.
 */
function splitByLever(precedents, { leverByDay, outcomeByDay, minArm = MIN_ARM, minGap = MIN_SPLIT_GAP } = {}) {
  const usable = (precedents || []).filter(
    (p) => Number.isFinite(leverByDay?.[p.day]) && Number.isFinite(outcomeByDay?.[p.day])
  );
  if (usable.length < minArm * 2) return null;

  const loads = usable.map((p) => leverByDay[p.day]);
  const cut = median(loads);
  if (cut == null) return null;
  // A degenerate split (everything on one side of its own median) cannot
  // support a "you did X vs you did Y" claim.
  const lighter = usable.filter((p) => leverByDay[p.day] < cut);
  const harder = usable.filter((p) => leverByDay[p.day] >= cut);
  if (lighter.length < minArm || harder.length < minArm) return null;

  const lighterDelta = mean(lighter.map((p) => outcomeByDay[p.day]));
  const harderDelta = mean(harder.map((p) => outcomeByDay[p.day]));
  if (Math.abs(lighterDelta - harderDelta) < minGap) return null;

  return {
    cutoff: Math.round(cut),
    lighter: {
      n: lighter.length,
      days: lighter.map((p) => p.day).sort(),
      meanNextDayDelta: Math.round(lighterDelta * 10) / 10,
      meanLoad: Math.round(mean(lighter.map((p) => leverByDay[p.day]))),
    },
    harder: {
      n: harder.length,
      days: harder.map((p) => p.day).sort(),
      meanNextDayDelta: Math.round(harderDelta * 10) / 10,
      meanLoad: Math.round(mean(harder.map((p) => leverByDay[p.day]))),
    },
  };
}

/**
 * The features that make today distinctive, most extreme first — the honest
 * answer to "similar HOW?". Reports the real observed value alongside the
 * z-score so the reader can sanity-check the claim against their own memory
 * of the night.
 */
function describeState(todayVector, rawToday, spec = FEATURE_SPEC, limit = 3) {
  return spec
    .filter((f) => Number.isFinite(todayVector?.[f.key]))
    .map((f) => ({
      key: f.key,
      label: f.label,
      z: Math.round(todayVector[f.key] * 100) / 100,
      value: Number.isFinite(rawToday?.[f.key]) ? Math.round(rawToday[f.key] * 10) / 10 : null,
      direction: todayVector[f.key] >= 0 ? 'above' : 'below',
    }))
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, limit);
}

/**
 * Assemble the whole projection from already-read data. Pure — this is the
 * function the tests drive, and the one that owns every gate.
 *
 * @param {object} input
 * @param {string} input.today YYYY-MM-DD.
 * @param {Record<string, Record<string, number>>} input.vectorsByDay z-scored
 *   state vectors, including today's.
 * @param {Record<string, Record<string, number>>} input.rawByDay the same
 *   vectors' raw observed values, for display.
 * @param {Record<string, number>} input.recoveryByDay day -> recovery score.
 * @param {Record<string, number>} input.leverByDay day -> that day's active energy.
 * @returns {object|null} the precedent projection, or null when the evidence
 *   does not support one.
 */
function buildPrecedent({ today, vectorsByDay, rawByDay = {}, recoveryByDay = {}, leverByDay = {} } = {}) {
  const todayVector = vectorsByDay?.[today];
  if (!todayVector) return null;

  // Candidates: every day strictly before today that has a vector. Yesterday
  // is excluded as well as today — its "next day" outcome IS today, which is
  // still in progress and therefore not an outcome yet.
  const cutoff = addDays(today, -1);
  const historyVectors = {};
  for (const [day, vec] of Object.entries(vectorsByDay)) {
    if (day < cutoff) historyVectors[day] = vec;
  }

  const precedents = rankPrecedents({ todayVector, historyVectors });
  if (precedents.length < MIN_PRECEDENTS) return null;

  // Outcome: how recovery MOVED from the precedent day to the day after it.
  // Requires both endpoints to genuinely exist — a missing next-day reading
  // drops that precedent from the comparison rather than being treated as
  // zero movement.
  const outcomeByDay = {};
  for (const p of precedents) {
    const cur = recoveryByDay[p.day];
    const next = recoveryByDay[addDays(p.day, 1)];
    if (Number.isFinite(cur) && Number.isFinite(next)) outcomeByDay[p.day] = next - cur;
  }

  const comparison = splitByLever(precedents, { leverByDay, outcomeByDay });

  const withOutcome = precedents.filter((p) => Number.isFinite(outcomeByDay[p.day]));
  const days = precedents.map((p) => p.day).sort();

  return {
    asOf: today,
    count: precedents.length,
    // The window the evidence actually spans — a precedent set drawn entirely
    // from one fortnight means something different from one drawn from six
    // months, and the reader is entitled to see which they are looking at.
    earliest: days[0],
    latest: days[days.length - 1],
    state: describeState(todayVector, rawByDay[today]),
    precedents: precedents.map((p) => ({
      day: p.day,
      similarity: Math.round(p.similarity * 100),
      sharedFeatures: p.sharedCount,
      recovery: Number.isFinite(recoveryByDay[p.day]) ? Math.round(recoveryByDay[p.day]) : null,
      nextDayDelta: Number.isFinite(outcomeByDay[p.day]) ? Math.round(outcomeByDay[p.day] * 10) / 10 : null,
      load: Number.isFinite(leverByDay[p.day]) ? Math.round(leverByDay[p.day]) : null,
    })),
    comparison,
    evidence: {
      minSimilarity: MIN_SIMILARITY,
      minSharedFeatures: MIN_SHARED_FEATURES,
      baselineDays: BASELINE_DAYS,
      withOutcome: withOutcome.length,
      leverMetric: 'health:active_energy',
      outcomeMetric: 'recovery next day',
    },
  };
}

// --- IO wrapper ----------------------------------------------------------

/**
 * Read the spine and build today's precedent projection.
 *
 * Every read goes through an existing store function — this module adds no
 * SQL of its own. `dailyAggregatePreferSource` is the same per-day,
 * source-priority-resolved accessor intelligence/recovery.js uses, so a day
 * here means exactly what it means there (one local calendar day, Eight
 * Sleep preferred over an Apple Health duplicate of the same night).
 *
 * @param {object} [opts]
 * @param {string} [opts.today] YYYY-MM-DD; defaults to the local day in `tz`.
 * @param {number} [opts.days] how far back to look for precedents.
 * @returns {Promise<object|null>}
 */
async function computePrecedent({ today = null, tz = process.env.TZ || 'America/New_York', days = 180 } = {}) {
  const metricsStore = require('../store/metrics');
  const { localDateStr } = require('../util/date');
  const asOf = today || localDateStr(tz);

  // Pull enough lead-in that the OLDEST candidate day still has a full
  // trailing baseline to be z-scored against — otherwise the earliest weeks
  // of the window would silently drop out of the candidate pool.
  const from = new Date(Date.now() - (days + BASELINE_DAYS + 5) * 864e5);
  // Same day-keying as intelligence/recovery.js's recoveryHistory, deliberately
  // character-for-character: dailyAggregatePreferSource returns each bucket as
  // a local-midnight timestamp, and both modules must turn that into the same
  // YYYY-MM-DD or the precedent days would not line up with the recovery days
  // they are joined against. Consistency with the canonical history matters
  // more here than any independently "better" formulation.
  const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

  // HRV and resting HR are read under the SAME night-source lock
  // intelligence/recovery.js applies (see its NIGHT_SOURCES comment: every
  // non-recovery consumer reading these two for a recovery-equivalent purpose
  // must share this lock rather than re-derive one). Without it, a daytime
  // Apple Watch HRV could define "a morning like today" while the outcome
  // being reported — next-day recovery — was computed from the overnight
  // Eight Sleep reading, so the card would be comparing two different
  // quantities and calling them the same name.
  const { RECOVERY_SOURCE_LOCK } = require('./recovery');

  const metricKeys = [...new Set(FEATURE_SPEC.map((f) => f.key).filter((k) => !k.startsWith('prev:')))];
  const seriesByKey = {};
  await Promise.all(
    metricKeys.map(async (key) => {
      const [domain, metric] = key.split(':');
      const rows = await metricsStore.dailyAggregatePreferSource({
        domain, metric, from, agg: 'avg', tz, sources: RECOVERY_SOURCE_LOCK[key] ?? null,
      });
      const byDay = {};
      for (const r of rows) byDay[dayKey(r.day)] = Number(r.value);
      seriesByKey[key] = byDay;
    })
  );

  // Active energy serves two purposes: yesterday's value is a FEATURE (the
  // load carried into the morning), and the same day's value is the LEVER
  // (what was done that day). Read once, used twice.
  const activeRows = await metricsStore.dailyAggregatePreferSource({
    domain: 'health', metric: 'active_energy', from, agg: 'sum', tz,
  });
  const activeByDay = {};
  for (const r of activeRows) activeByDay[dayKey(r.day)] = Number(r.value);
  const prevActiveByDay = {};
  for (const day of Object.keys(activeByDay)) prevActiveByDay[addDays(day, 1)] = activeByDay[day];
  seriesByKey['prev:active_energy'] = prevActiveByDay;

  // z-score each feature independently, causally.
  const zByKey = {};
  for (const [key, byDay] of Object.entries(seriesByKey)) zByKey[key] = causalZScores(byDay);

  // Pivot into per-day vectors (z) and per-day raw values (for display).
  const vectorsByDay = {};
  const rawByDay = {};
  for (const [key, zByDay] of Object.entries(zByKey)) {
    for (const [day, z] of Object.entries(zByDay)) {
      (vectorsByDay[day] ||= {})[key] = z;
      (rawByDay[day] ||= {})[key] = seriesByKey[key][day];
    }
  }

  // Outcome series: the canonical recovery history, never a re-derivation.
  // recoveryHistory returns { ts, value, proxy } rows, where ts is that local
  // day anchored at midday UTC — so the ISO date prefix IS the local day key
  // the rest of this module uses.
  const recovery = require('./recovery');
  const history = await recovery.recoveryHistory({ days: days + 2 });
  const recoveryByDay = {};
  for (const r of history || []) {
    const d = String(r.ts).slice(0, 10);
    if (Number.isFinite(Number(r.value))) recoveryByDay[d] = Number(r.value);
  }

  return buildPrecedent({ today: asOf, vectorsByDay, rawByDay, recoveryByDay, leverByDay: activeByDay });
}

// A precedent set changes at most once a day: overnight metrics land in the
// morning and every prior day's inputs are settled. Two callers want the same
// answer within the same minute — the /api/precedent route the Today card
// fetches, and chat/ask.js's precedentContext() when the user immediately asks
// about it — so the memo lives HERE, in the engine, rather than in either
// caller. Putting it in the route would have left Ask silently re-running the
// whole 180-day scan on every personal question.
const CACHE_TTL_MS = Number(process.env.PRECEDENT_CACHE_MS) || 15 * 60 * 1000;
const _cache = new Map();

/**
 * computePrecedent, memoized per (day, tz, window). Same signature, same
 * return value. `force: true` bypasses and refills the memo.
 */
async function cachedPrecedent({ today = null, tz = process.env.TZ || 'America/New_York', days = 180, force = false } = {}) {
  const { localDateStr } = require('../util/date');
  const asOf = today || localDateStr(tz);
  const key = `${asOf}|${tz}|${days}`;
  const hit = _cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await computePrecedent({ today: asOf, tz, days });
  // Keyed by local day, so this map can only ever hold a handful of entries in
  // a long-lived process; prune anything expired on write rather than letting
  // it grow.
  for (const [k, v] of _cache) if (Date.now() - v.at >= CACHE_TTL_MS) _cache.delete(k);
  _cache.set(key, { at: Date.now(), value });
  return value;
}

/** Test/ops seam — drop the memo so a fresh computation is guaranteed. */
function invalidatePrecedentCache() {
  _cache.clear();
}

module.exports = {
  computePrecedent,
  cachedPrecedent,
  invalidatePrecedentCache,
  buildPrecedent,
  causalZScores,
  gowerDistance,
  rankPrecedents,
  splitByLever,
  describeState,
  addDays,
  FEATURE_SPEC,
  MIN_PRECEDENTS,
  MIN_SIMILARITY,
  MIN_SHARED_FEATURES,
  MIN_ARM,
  MIN_SPLIT_GAP,
};
