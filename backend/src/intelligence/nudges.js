// Proactive nudge engine (Phase 6).
//
// Turns the current open findings (forecasts, leverage actions, worsening
// trends) into a short, ranked list of push-worthy messages — the "7am text"
// that makes NormOS a chief of staff instead of a dashboard you have to open.
//
// Pure and deterministic: `buildNudges` takes findings + what was recently sent
// and returns ranked, de-duplicated candidates. Delivery (Expo push, devices,
// scheduling) lives in `notify/`. This separation keeps the judgement —
// *which* insight, *how urgent* — fully unit-testable.

const DEFAULTS = {
  max: 3, // never fire a barrage; a chief of staff is concise
  minPriority: 0.35, // below this, not worth interrupting someone's morning
};

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

function round(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return n;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// --- candidate builders (one per finding type) --------------------------------

function fromForecast(f) {
  const ev = f.evidence || {};
  if (ev.status !== 'off_track' && ev.status !== 'at_risk') return null;
  const probability = f.confidence ?? 0.5;
  return {
    key: `forecast:${ev.goalId || slugify(f.title)}`,
    title: ev.status === 'off_track' ? 'A goal is off track' : 'A goal needs attention',
    body: f.detail ? `${f.title} — ${f.detail}` : f.title,
    // The less likely you are to hit it, the louder this should be.
    priority: round(0.5 + 0.5 * (1 - probability)),
    basis: { type: 'forecast', status: ev.status, goalId: ev.goalId ?? null, probability },
  };
}

function fromLeverage(f) {
  const ev = f.evidence || {};
  // Only the single highest-ranked action earns a push.
  if (ev.rank != null && ev.rank !== 0) return null;
  const score = Number.isFinite(ev.score) ? ev.score : 0;
  return {
    key: `leverage:${slugify(f.title)}`,
    title: "Today's highest-leverage move",
    body: f.detail ? `${f.title} — ${f.detail}` : f.title,
    priority: round(Math.max(0.6, score)), // the front-page action is always worth surfacing
    basis: { type: 'leverage', score },
  };
}

function fromTrend(f) {
  // Only clearly worsening, confident trends earn an interruption — a marginal
  // wobble isn't worth a 7am ping.
  if (!/worsening/i.test(f.title || '')) return null;
  const conf = f.confidence ?? 0;
  if (conf < 0.6) return null;
  const ev = f.evidence || {};
  return {
    key: `trend:${ev.metric || slugify(f.title)}`,
    title: 'Heads up',
    body: f.title,
    priority: round(0.4 + 0.4 * (conf - 0.6)),
    basis: { type: 'trend', metric: ev.metric ?? null, confidence: conf },
  };
}

const BUILDERS = { forecast: fromForecast, leverage: fromLeverage, trend: fromTrend };

/**
 * Build ranked, de-duplicated nudge candidates from open findings.
 *
 * @param {object} args
 * @param {Array} args.findings - open findings (DB-shaped: {type, title, detail, confidence, evidence})
 * @param {Set<string>} [args.recentKeys] - dedup_keys already delivered recently (suppressed)
 * @param {number} [args.max] - cap on nudges per run
 * @param {number} [args.minPriority] - drop candidates below this
 * @returns {Array<{key, title, body, priority, basis}>}
 */
function buildNudges({ findings = [], recentKeys = new Set(), ...opts } = {}) {
  const o = { ...DEFAULTS, ...opts };

  // One candidate per finding, via the builder for its type.
  const byKey = new Map();
  for (const f of findings) {
    const build = BUILDERS[f.type];
    if (!build) continue;
    const cand = build(f);
    if (!cand) continue;
    if (cand.priority < o.minPriority) continue;
    if (recentKeys.has(cand.key)) continue; // don't nag with the same insight
    // If two findings map to the same key, keep the louder one.
    const prev = byKey.get(cand.key);
    if (!prev || cand.priority > prev.priority) byKey.set(cand.key, cand);
  }

  return [...byKey.values()]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, o.max);
}

/**
 * Is `date` inside the quiet window [endHour, startHour) wrapping midnight?
 * Defaults to 21:00–07:00 local. Used by the runner to avoid 3am pings.
 */
function withinQuietHours(date = new Date(), { startHour = 21, endHour = 7 } = {}) {
  const h = date.getHours();
  return startHour > endHour ? h >= startHour || h < endHour : h >= startHour && h < endHour;
}

module.exports = { buildNudges, withinQuietHours, slugify, DEFAULTS };
