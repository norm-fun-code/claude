// Curation layer — the editor that sits on top of every insight generator.
//
// The generators (trends, anomalies, correlations, habit/sleep/activity splits,
// cross-context) each emit findings that clear their own threshold. That gives a
// CORRECT list, but not a GOOD one: a +5% sleep effect would sit above a 4-sigma
// "your HRV cratered this morning" simply because of type order, the same
// 45-day-old confirmed correlation re-appears every single day with full weight,
// and the same metric shows up three times (a trend, an anomaly, and inside a
// correlation). World-class means ruthless editing — surface the few things that
// actually matter today, ordered by how much they matter.
//
// curate() scores every finding on ONE comparable scale, dedupes redundant
// single-metric findings, and returns them ranked. Score blends four signals:
//
//   importance  — intrinsic value/actionability of the finding TYPE (fixed)
//   magnitude   — effect size, normalized per type from the finding's evidence
//   confidence  — statistical strength the generator already computed
//   novelty     — how new/changed this is, from a stable first-seen ledger
//
//   score = importance × (0.45·magnitude + 0.25·confidence + 0.30·novelty)
//
// importance is the dominant multiplier so a trend can never outrank a sleep
// lever of equal magnitude; within a type, magnitude/novelty/confidence order
// them. Pure scoring (scoreFindings) is separated from the DB-backed novelty
// ledger (curate) so the ranking math is unit-testable in isolation.

const { dismissKey } = require('../store/dismissedInsights');

// Intrinsic worth of each finding type — actionability and how much the user
// cares. cross_context (cross-domain synthesis) is the differentiator and tops
// the scale; raw trends are the least actionable and sit at the bottom.
const IMPORTANCE = {
  // Under-recovery synthesis is the highest-priority actionable warning — a
  // multi-signal overreaching flag the user needs to see before a single low card.
  strain: 0.96,
  cross_context: 1.0,
  sleep_impact: 0.92,
  activity_impact: 0.88,
  habit_split: 0.88,
  anomaly: 0.8,
  // VO₂ max — a featured longevity metric. Not urgent-today, but high enough to
  // resurface periodically rather than getting buried under daily churn.
  fitness: 0.7,
  correlation: 0.68,
  habit_consistency: 0.55,
  trend: 0.5,
};
const IMPORTANCE_DEFAULT = 0.6;

// Single-variable finding types — two findings of these types about the SAME
// metric (a trend AND an anomaly on HRV) are redundant; keep the stronger one.
// Relational types (correlation/split/impact) involve two metrics and a distinct
// claim, so they're never collapsed against single-metric findings.
const SINGLE_VAR_TYPES = new Set(['trend', 'anomaly']);

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Stable identity for a finding — keyed on the underlying metric/relationship,
 * NOT the exact numbers, so a persistent HRV uptrend keeps one signature as its
 * percentage drifts (and correctly recedes over time). Falls back to the
 * number-stripped dismissKey for findings without structured evidence.
 */
function signature(f) {
  const ev = f.evidence || {};
  if (ev.metric) return `${f.type}|${ev.metric}`;
  if (ev.a && ev.b) return `${f.type}|${[ev.a, ev.b].sort().join('~')}`;
  if (ev.habit && ev.outcome) return `${f.type}|${ev.habit}|${ev.outcome}`;
  if (ev.driver && ev.outcome) return `${f.type}|${ev.driver}|${ev.outcome}`;
  if (ev.activity && ev.outcome) return `${f.type}|${ev.activity}|${ev.outcome}`;
  return dismissKey(f);
}

/** Primary metric a single-variable finding is "about" (for dedupe grouping). */
function primaryMetric(f) {
  return f.evidence?.metric || null;
}

/**
 * Effect size on a 0–1 scale, read from each type's evidence. Normalizers are
 * chosen so a "big deal" effect for that metric type lands near 1.0:
 *   trend        — 50% change is a full-scale move
 *   anomaly      — 4 sigma is off-the-charts
 *   correlation  — |r| is already 0–1
 *   *_split/impact — 30% group difference is a strong, actionable gap
 */
function magnitude(f) {
  const ev = f.evidence || {};
  switch (f.type) {
    case 'trend':
      return ev.pctChange != null ? clamp01(Math.abs(ev.pctChange) / 0.5) : 0.5;
    case 'anomaly':
      return ev.z != null ? clamp01(Math.abs(ev.z) / 4) : 0.5;
    case 'correlation':
      return ev.r != null ? clamp01(Math.abs(ev.r)) : 0.5;
    case 'habit_split':
    case 'sleep_impact':
    case 'activity_impact':
      return ev.pct != null ? clamp01(Math.abs(ev.pct) / 0.3) : 0.5;
    case 'habit_consistency':
      return ev.adherence != null ? clamp01(ev.adherence) : 0.6;
    case 'strain':
      // Severity already blends signal count + autonomic pair + magnitude (0–1).
      return ev.severity != null ? clamp01(ev.severity) : 0.8;
    case 'fitness':
      // Mostly steady; floor it so a strong-but-flat VO₂ max still surfaces, and
      // a real quarter-over-quarter move (≥3 pts) reads as a big deal.
      return ev.per90 != null ? clamp01(0.4 + Math.abs(ev.per90) / 3) : 0.5;
    case 'cross_context':
      // LLM synthesis carries no numeric effect — lean on its confidence.
      return f.confidence != null ? clamp01(f.confidence) : 0.7;
    default:
      return f.confidence != null ? clamp01(f.confidence) : 0.5;
  }
}

/**
 * Novelty from age: brand-new findings score ~1.0 and decay toward a 0.4 floor
 * so a long-confirmed pattern still carries weight but stops dominating the card.
 * Smooth exponential: age 0 → 1.0, ~5d → 0.62, ~14d → 0.44, 30d+ → ~0.40.
 */
function noveltyFromAge(ageDays) {
  if (ageDays == null || !Number.isFinite(ageDays)) return 1.0; // unseen = treat as new
  return clamp01(0.4 + 0.6 * Math.exp(-Math.max(0, ageDays) / 5));
}

/** Score one finding given its novelty. Returns the finding annotated with
 *  `_score` and `_scoreParts` (kept off the wire by the server). */
function scoreFinding(f, novelty) {
  const importance = IMPORTANCE[f.type] ?? IMPORTANCE_DEFAULT;
  const mag = magnitude(f);
  const conf = f.confidence != null ? clamp01(f.confidence) : 0.5;
  const nov = novelty != null ? clamp01(novelty) : 1.0;
  const salience = 0.45 * mag + 0.25 * conf + 0.3 * nov;
  const score = importance * salience;
  return {
    ...f,
    _signature: signature(f),
    _score: Math.round(score * 1000) / 1000,
    _scoreParts: {
      importance,
      magnitude: Math.round(mag * 1000) / 1000,
      confidence: Math.round(conf * 1000) / 1000,
      novelty: Math.round(nov * 1000) / 1000,
    },
  };
}

/**
 * Pure ranking: score → dedupe redundant single-metric findings → sort.
 *   findings       — raw findings to rank
 *   firstSeenBySig — Map(signature → first_seen Date) for novelty; missing = new
 *   now            — reference time (defaults to now)
 * Returns findings sorted by score desc, each annotated with `_score`.
 */
function scoreFindings(findings, { firstSeenBySig = new Map(), now = new Date() } = {}) {
  const scored = findings.map((f) => {
    const sig = signature(f);
    const first = firstSeenBySig.get(sig);
    const ageDays = first ? (now.getTime() - new Date(first).getTime()) / 864e5 : null;
    return scoreFinding(f, noveltyFromAge(ageDays));
  });

  // Dedupe: among single-variable findings (trend/anomaly) about the SAME metric,
  // keep only the highest-scored — don't show both "HRV trending down" and "HRV
  // below your baseline". Relational findings always pass through.
  const bestSingleByMetric = new Map();
  const kept = [];
  for (const f of scored.sort((a, b) => b._score - a._score)) {
    if (SINGLE_VAR_TYPES.has(f.type)) {
      const m = primaryMetric(f);
      if (m) {
        if (bestSingleByMetric.has(m)) continue; // a stronger one already won
        bestSingleByMetric.set(m, true);
      }
    }
    kept.push(f);
  }
  return kept; // already sorted by score desc
}

/**
 * DB-backed novelty ledger. Records each current signature's first/last sighting
 * and returns first_seen for every one in a single round-trip. Self-pruning:
 * signatures unseen for 90 days are dropped so the table stays tiny.
 */
async function recordAndLoadFirstSeen(signatures, db) {
  const query = db || require('../db').query;
  const sigs = [...new Set(signatures)];
  if (sigs.length === 0) return new Map();

  // Upsert all current signatures: insert new ones at now(), bump last_seen on
  // existing ones (first_seen is preserved by leaving it out of the UPDATE).
  await query(
    `INSERT INTO finding_first_seen (signature)
       SELECT unnest($1::text[])
     ON CONFLICT (signature)
       DO UPDATE SET last_seen = now()`,
    [sigs]
  );
  await query(`DELETE FROM finding_first_seen WHERE last_seen < now() - interval '90 days'`);

  const { rows } = await query(
    `SELECT signature, first_seen FROM finding_first_seen WHERE signature = ANY($1::text[])`,
    [sigs]
  );
  const map = new Map();
  for (const r of rows) map.set(r.signature, r.first_seen);
  return map;
}

/**
 * Full curation: load novelty from the ledger, score + dedupe + rank. Resilient —
 * if the ledger query fails, falls back to scoring with everything treated as new
 * (still correctly ordered by importance × magnitude × confidence).
 */
async function curate(findings, { now = new Date(), db = null } = {}) {
  if (!Array.isArray(findings) || findings.length === 0) return [];
  let firstSeenBySig = new Map();
  try {
    const sigs = findings.map(signature);
    firstSeenBySig = await recordAndLoadFirstSeen(sigs, db);
  } catch (err) {
    console.error('[curate] novelty ledger unavailable, scoring all as new:', err.message);
  }
  return scoreFindings(findings, { firstSeenBySig, now });
}

module.exports = {
  curate,
  scoreFindings,
  scoreFinding,
  signature,
  magnitude,
  noveltyFromAge,
  recordAndLoadFirstSeen,
  IMPORTANCE,
};
