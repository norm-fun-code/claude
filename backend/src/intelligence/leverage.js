// Highest Leverage Action engine.
//
// Answers "what's the single most important thing I can do right now?" by
// converting PERSONAL findings (habit_splits, sleep_impact, activity_impact,
// confirmed correlations, off-track goals, worsening trends) into concrete,
// specific, numbered actions — then ranking by impact × confidence × ease.
//
// Philosophy: show 3 sharp insights the user couldn't have guessed, grounded
// in their own N-of-1 data. Generic advice ("sleep more") is filtered out.
const cat = require('./catalog');
const { formatDate } = require('../util/date');

// Outcomes worth acting on. Excludes structural wealth metrics (net_worth,
// net_cashflow) — they move over years, not 14-day experiment windows.
// Excludes deep_sleep_hours / rem_sleep_hours — they're components of
// sleep_score, already represented. Excludes vo2_max — rarely measured.
const OUTCOMES = new Set([
  'wellbeing:mood',
  'wellbeing:energy',
  'wellbeing:focus',
  'health:hrv',
  'health:resting_hr',
  'health:sleep_score',
]);

// Lever→outcome pairs that are compositionally obvious (the lever is a direct
// input to the outcome's formula). Telling the user "sleep more to improve
// sleep score" is a definition, not insight.
const TAUTOLOGICAL_PAIRS = new Set([
  'health:sleep_hours|health:sleep_score',
  'health:deep_sleep_hours|health:sleep_hours',
  'health:rem_sleep_hours|health:sleep_hours',
  'health:deep_sleep_hours|health:sleep_score',
  'health:rem_sleep_hours|health:sleep_score',
]);

// lever metric -> { ease 0..1, more: phrase to increase, less: phrase to decrease }
const LEVERS = {
  'health:sleep_hours':     { ease: 0.5, more: 'protect more sleep', less: 'cut excess time in bed' },
  'health:exercise_minutes':{ ease: 0.5, more: 'train more', less: 'ease training load' },
  'health:active_energy':   { ease: 0.5, more: 'add more active movement', less: 'ease training load' },
  'health:steps':           { ease: 0.7, more: 'walk more', less: 'walk less' },
  'health:mindful_minutes': { ease: 0.7, more: 'add mindfulness', less: 'cut mindfulness' },
  'productivity:meetings':  { ease: 0.6, more: 'add meetings', less: 'cut meetings / protect focus blocks' },
  // Habits: high-agency binary choices you make each day.
  'habits:exercise':     { ease: 0.6, more: 'keep the exercise habit', less: 'ease off exercise' },
  'habits:morning_tm':   { ease: 0.8, more: 'hold the morning meditation', less: 'drop the morning meditation' },
  'habits:afternoon_tm': { ease: 0.8, more: 'hold the afternoon meditation', less: 'drop the afternoon meditation' },
  'habits:cold_shower':  { ease: 0.8, more: 'keep the cold showers', less: 'skip the cold showers' },
  'habits:gratitude':    { ease: 0.9, more: 'keep journaling gratitude', less: 'skip gratitude journaling' },
  'habits:eat_healthy':  { ease: 0.5, more: 'eat cleaner', less: 'loosen the diet' },
  'habits:habit_score':  { ease: 0.5, more: 'hit more of your daily habits', less: 'do fewer habits' },
};

// Habit label → canonical key (for habit_split findings that store display names).
const HABIT_KEY = {
  'Cold shower':        'habits:cold_shower',
  'Morning meditation': 'habits:morning_tm',
  'Morning TM':         'habits:morning_tm',
  'Afternoon meditation':'habits:afternoon_tm',
  'Afternoon TM':       'habits:afternoon_tm',
  'Gratitude practice': 'habits:gratitude',
  'Gratitude journal':  'habits:gratitude',
  'Exercise':           'habits:exercise',
  'Both meditations':   'habits:morning_tm',
};

// Worsening trend on these specific metrics gets a coaching nudge even without
// a confirmed correlation, because a health coach would immediately flag them.
// For all other metrics the trend finding already appears in the Insights tab —
// the leverage engine should add the LEVER, not just re-state the trend.
const TREND_COACHING = {
  'wellbeing:mood':     'Check your recent sleep quality, meeting load, and any life stressors. Mood is the first signal that something is off.',
  'wellbeing:energy':   'Energy decline tracks closely with sleep debt and detraining. Prioritize sleep this week and get one Zone 2 session in.',
  'wellbeing:focus':    'Protect two or more uninterrupted morning hours and cut reactive tasks until this reverses.',
  'health:hrv':         'HRV decline is an early warning of accumulated stress or under-recovery. Add a rest day, audit sleep quality, and reduce training intensity.',
  'health:resting_hr':  'Elevated resting HR is an early stress signal. Add a rest day and check whether sleep quality or training load is the culprit.',
  'health:steps':       'Get back to your daily step target — even two 15-minute walks add up fast.',
};

const DOMAIN_WEIGHT = {
  wellbeing: 1.0,
  health: 0.9,
  wealth: 0.9,
  productivity: 0.7,
  learning: 0.6,
  environment: 0.2,
};

function splitKey(key) {
  const i = key.indexOf(':');
  return { domain: key.slice(0, i), metric: key.slice(i + 1) };
}

function clamp01(n) { return Math.max(0, Math.min(1, n)); }

// Stable identity for a finding's basis — survives copy/wording changes to the
// title (unlike normalizeRecTitle, which only survives NUMBER changes). Used
// to dedupe the recommendation ledger by what the insight actually IS, not by
// how it happens to be phrased today.
function basisKey(basis) {
  if (!basis || !basis.kind) return null;
  const parts = [basis.kind];
  if (basis.lever) parts.push(basis.lever);
  if (basis.outcome) parts.push(basis.outcome);
  if (basis.metric) parts.push(basis.metric);
  if (basis.habit) parts.push(basis.habit);
  if (basis.activity) parts.push(basis.activity);
  if (basis.goalId != null) parts.push(String(basis.goalId));
  return parts.join('|');
}

function round(n, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// Human-readable metric value for prose: large counts (steps, calories) render
// as comma-grouped integers — "10,781", not "10780.7" — while small values
// (HRV, sleep hours) keep one decimal where it carries meaning.
function fmtMean(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  return Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : String(round(n, 1));
}

// ── Source generators ──────────────────────────────────────────────────────

// Worsening trend → coaching nudge. Only fires for metrics where we have a
// specific, concrete action — not a vague "reverse the decline."
function fromTrend(f) {
  const ev = f.evidence || {};
  if (ev.kind !== 'trend' || ev.pctChange == null) return null;
  const { domain, metric } = splitKey(ev.metric);
  const good = cat.goodWhen(domain, metric);
  const worsening = (good === 'up' && ev.pctChange < 0) || (good === 'down' && ev.pctChange > 0);
  if (!worsening) return null;

  const coaching = TREND_COACHING[ev.metric];
  if (!coaching) return null; // no specific lever → don't generate a vague action

  const label = cat.label(domain, metric);
  const absPct = Math.abs(Math.round(ev.pctChange * 100));
  const impact = clamp01(Math.abs(ev.pctChange) / 0.35) * (DOMAIN_WEIGHT[domain] ?? 0.5);
  const confidence = clamp01(f.confidence ?? 0.5);
  const ease = 0.5;

  return {
    title: `${label} down ${absPct}% — act this week`,
    detail: `${label} dropped ${absPct}% recently (${fmtMean(ev.recentMean)} vs ${fmtMean(ev.priorMean)} prior). ${coaching}`,
    domains: [domain],
    impact,
    confidence,
    ease,
    basis: { kind: 'trend', metric: ev.metric },
  };
}

// Confirmed (split-half stable) lever/outcome correlation. Only fires on
// confirmed correlations — unconfirmed ones become experiment proposals
// instead. "Confirmed" here means statistically robust (held up across an
// early/late holdout split of the aligned series), not causally proven.
function fromCorrelation(f) {
  const ev = f.evidence || {};
  if (ev.kind !== 'correlation' || ev.r == null) return null;
  if (ev.confirmed === false) return null;

  let lever, outcome;
  if (LEVERS[ev.a] && OUTCOMES.has(ev.b)) { lever = ev.a; outcome = ev.b; }
  else if (LEVERS[ev.b] && OUTCOMES.has(ev.a)) { lever = ev.b; outcome = ev.a; }
  else return null;

  const pairKey = [lever, outcome].sort().join('|');
  if (TAUTOLOGICAL_PAIRS.has(pairKey)) return null;

  const lv = splitKey(lever);
  const ov = splitKey(outcome);
  const leverLabel = cat.label(lv.domain, lv.metric);
  const outcomeLabel = cat.label(ov.domain, ov.metric);
  const wantOutcomeUp = cat.goodWhen(ov.domain, ov.metric) !== 'down';
  const positive = ev.r >= 0;
  const direction = (positive === wantOutcomeUp) ? 'more' : 'less';
  const phrase = LEVERS[lever][direction];
  const lagNote = ev.lag ? ` — shows up ~${ev.lag}d later, not the same day` : '';
  const rStr = `r=${round(Math.abs(ev.r), 2)}`;

  const impact = clamp01(Math.abs(ev.r)) * (DOMAIN_WEIGHT[ov.domain] ?? 0.5);
  const confidence = clamp01(Math.abs(ev.r));
  const ease = LEVERS[lever].ease;

  // Deliberately tentative, not an imperative "do X to move the needle" —
  // this is a statistically robust OBSERVATIONAL correlation (held up across
  // an early/late holdout split), not a proven cause. A causal "do this"
  // recommendation is reserved for a completed, CONFIRMED self-experiment;
  // absent one, the most this can honestly say is that the pattern is
  // consistent enough to be worth testing deliberately.
  return {
    title: `${leverLabel} and ${outcomeLabel}: ${phrase}`,
    detail: `Your data shows a consistent pattern (${rStr}${lagNote}): ${leverLabel} and ${outcomeLabel} move together, holding up in both an earlier and a more recent stretch of your data — not just a one-off. Worth deliberately testing whether ${phrase} moves it, e.g. as a self-experiment; this is an observed association, not a proven cause.`,
    domains: [...new Set([lv.domain, ov.domain])],
    impact,
    confidence,
    ease,
    basis: { kind: 'correlation', lever, outcome, r: ev.r },
  };
}

// Habit_split finding — THE most personal and concrete insight type.
// "On your 23 cold shower days, HRV averaged 58ms vs 44ms on other days (+32%)"
// is N-of-1 data the user can act on immediately.
function fromHabitSplit(f) {
  const ev = f.evidence || {};
  if (ev.kind !== 'habit_split') return null;
  // A lagged (next-day) split is an observational pattern, not a confirmed
  // effect — the leverage engine only turns a SAME-DAY split into "do this"
  // advice. Without this gate, a two-mornings-later HRV split (already the
  // scientifically weaker claim) would generate the identical imperative
  // "streak it this week" framing as a same-day one, implying a certainty
  // the underlying observational data doesn't support.
  if (ev.lag) return null;
  const pct = ev.pct;
  if (pct == null || Math.abs(pct) < 0.07) return null; // require 7%+ difference

  const outcome = ev.outcome;
  if (!outcome) return null;
  const { domain, metric } = splitKey(outcome);
  const good = cat.goodWhen(domain, metric);
  const improved = (good === 'up' && pct > 0) || (good === 'down' && pct < 0);
  if (!improved) return null; // only surface when the habit clearly helps

  const habit = ev.habit;
  const outcomeLabel = cat.label(domain, metric);
  const onFmt = ev.onMean != null ? round(ev.onMean, 1) : '?';
  const offFmt = ev.offMean != null ? round(ev.offMean, 1) : '?';
  const unit = metric === 'hrv' ? 'ms' : metric === 'resting_hr' ? 'bpm' : metric === 'sleep_hours' ? 'h'
    : domain === 'wellbeing' ? '/5' : '';
  const fmtVal = (v) => unit ? `${v}${unit}` : String(v);

  const habitKey = HABIT_KEY[habit] || null;
  const ease = habitKey ? (LEVERS[habitKey]?.ease ?? 0.7) : 0.7;
  const impact = clamp01(Math.abs(pct) * 2.5) * (DOMAIN_WEIGHT[domain] ?? 0.7);
  const confidence = Math.min(0.88, 0.4 + Math.abs(pct) * 2);

  return {
    title: `${habit}: stronger ${outcomeLabel} on the days you do it`,
    detail: `Your own data (${ev.onN} days on vs ${ev.offN} off): on ${habit} days, ${outcomeLabel} averaged ${fmtVal(onFmt)} vs ${fmtVal(offFmt)} otherwise. Streak it this week.`,
    domains: [domain, 'habits'],
    impact,
    confidence,
    ease,
    basis: { kind: 'habit_split', habit, outcome },
  };
}

// Sleep_impact finding — best vs worst sleep nights × next-day outcomes.
// Shows the concrete stakes of a bad night ("your focus drops 40% after poor sleep").
function fromSleepImpact(f) {
  const ev = f.evidence || {};
  if (ev.kind !== 'sleep_impact') return null;
  const pct = ev.pct;
  if (pct == null || Math.abs(pct) < 0.10) return null; // require 10%+ effect

  const outcome = ev.outcome;
  if (!outcome) return null;
  const { domain, metric } = splitKey(outcome);
  const good = cat.goodWhen(domain, metric);
  const improved = (good === 'up' && pct > 0) || (good === 'down' && pct < 0);
  if (!improved) return null;

  const outcomeLabel = cat.label(domain, metric);
  const goodFmt = ev.goodMean != null ? round(ev.goodMean, 1) : '?';
  const poorFmt = ev.poorMean != null ? round(ev.poorMean, 1) : '?';
  const unit = metric === 'hrv' ? 'ms' : metric === 'resting_hr' ? 'bpm' : '';
  const fmtVal = (v) => unit ? `${v}${unit}` : String(v);

  const impact = clamp01(Math.abs(pct) * 1.8) * (DOMAIN_WEIGHT[domain] ?? 0.7);
  const confidence = Math.min(0.85, 0.35 + Math.abs(pct) * 2);
  const ease = 0.5;

  return {
    title: `Best sleep nights lift your next-day ${outcomeLabel}`,
    detail: `After your best-slept nights, ${outcomeLabel} runs ${fmtVal(goodFmt)} vs ${fmtVal(poorFmt)} after poor ones — across ${(ev.goodN ?? 0) + (ev.poorN ?? 0)} comparison days: ${ev.goodN} best-sleep nights vs ${ev.poorN} worst-sleep nights. Sleep quality is one of your strongest personal levers. Protect tomorrow's bedtime window.`,
    domains: [domain, 'health'],
    impact,
    confidence,
    ease,
    basis: { kind: 'sleep_impact', outcome },
  };
}

// Activity_impact finding — workout type vs next-day recovery.
// This is ALWAYS a next-day (lag=1) observational split by construction (the
// outcome is definitionally the morning after the logged activity) — same
// rule as fromHabitSplit's lag gate: the leverage engine does not turn an
// observational lagged split alone into "do this" advice ("schedule X before
// high-stakes days", "plan a lighter day after Y") without a completed
// experiment behind it. No experiment tracks activity-type-vs-next-day-
// recovery today, so this never becomes an actionable leverage item; the
// pattern itself still surfaces to the user via computeActivityImpact's own
// finding (Health tab / self-model), just not as a prescriptive action here.
function fromActivityImpact() {
  return null;
}

// Off-track goal. `forecastStatusByGoalId` (optional) is the SAME goals'
// trend-aware forecast status from forecast.js's computeForecasts — a
// time-series fit + hit-probability, strictly more informed than this
// function's own raw snapshot ratio. Live bug found via a product review:
// a goal 90% of the way there and trending strongly toward the target got
// `on_track` from the forecast model, while this function, going purely off
// raw progress, still emitted "Close the gap ... This is off-track" for the
// SAME goal in the SAME briefing. When the forecast already says on_track,
// defer to it and suppress this less-informed nudge entirely — mirroring
// the existing `progress >= 1` suppression just below, both are cases where
// nagging the user would be actively wrong, not just redundant.
function fromGoal(goal, latestByKey = {}, forecastStatusByGoalId = {}) {
  if (!goal.metric || goal.target_value == null) return null;
  const key = `${goal.domain}:${goal.metric}`;
  const current = latestByKey[key];
  if (current == null) return null;
  if (forecastStatusByGoalId[goal.id] === 'on_track') return null;

  const baseline = goal.baseline_value ?? current;
  const denom = goal.target_value - baseline;
  const progress = denom === 0 ? 1 : (current - baseline) / denom;
  if (progress >= 1) return null;

  const gap = clamp01(1 - progress);
  const impact = gap * (DOMAIN_WEIGHT[goal.domain] ?? 0.6);

  return {
    title: `Close the gap: ${goal.title}`,
    detail: (() => {
      const by = formatDate(goal.target_date);
      return `${Math.round(progress * 100)}% to target (${cat.label(goal.domain, goal.metric)} ${fmtMean(current)} → ${fmtMean(goal.target_value)}${by ? `, by ${by}` : ''}). This is off-track.`;
    })(),
    domains: [goal.domain],
    impact,
    confidence: 0.8,
    ease: 0.5,
    basis: { kind: 'goal', goalId: goal.id },
  };
}

// ── Router & ranker ────────────────────────────────────────────────────────

const GENERATORS = {
  trend:           fromTrend,
  correlation:     fromCorrelation,
  habit_split:     fromHabitSplit,
  sleep_impact:    fromSleepImpact,
  activity_impact: fromActivityImpact,
};

// The lever↔outcome pair an experiment verdict applies to, normalized from a
// candidate's basis. Correlation bases carry the canonical lever key directly;
// habit_split bases carry the habit's DISPLAY name, so map it back through
// HABIT_KEY. Returns null for basis kinds experiments don't test.
function experimentGateKey(basis) {
  if (!basis) return null;
  const lever = basis.lever || (basis.habit ? HABIT_KEY[basis.habit] : null);
  if (!lever || !basis.outcome) return null;
  return `${lever}|${basis.outcome}`;
}

/**
 * Pure: rank actions from findings (all types) + goals.
 * Returns up to `max` leverage finding objects, highest score first.
 * Drops any action whose score is below MIN_SCORE — low-signal advice is worse
 * than no advice.
 *
 * `outcomeHistory` ({dedupKey -> {helped, noEffect}}, from the recommendation
 * ledger's measured 7-day deltas) and `experimentVerdicts`
 * ({'lever|outcome' -> 'confirmed'|'refuted'}, from completed self-experiments)
 * close the learning loop: for years this ranking was a pure function of
 * current findings, structurally blind to whether its own past advice worked —
 * a measured "no effect" was narrated to the user but never changed what got
 * recommended, and a formally REFUTED hypothesis kept resurfacing as leverage
 * whenever its (correlational) finding re-cleared the threshold.
 */
function rankActions(findings = [], { goals = [], latestByKey = {}, forecastStatusByGoalId = {}, outcomeHistory = {}, experimentVerdicts = {}, max = 3, minScore = 0.05 } = {}) {
  const candidates = [];

  for (const f of findings) {
    const gen = GENERATORS[f.type];
    if (!gen) continue;
    const action = gen(f);
    if (action) candidates.push(action);
  }
  for (const g of goals) {
    const action = fromGoal(g, latestByKey, forecastStatusByGoalId);
    if (action) candidates.push(action);
  }

  // Score and de-dupe by title (keep strongest per unique action).
  const byTitle = new Map();
  for (const c of candidates) {
    // Experiment verdicts outrank correlation: a REFUTED lever→outcome pair
    // was tested on the user's own data and showed nothing — re-suggesting it
    // because the (weaker) correlational evidence still exists is exactly the
    // "doesn't remember what it ruled out" failure. A CONFIRMED pair earned
    // more confidence than any correlation alone can.
    const gateKey = experimentGateKey(c.basis);
    const verdict = gateKey ? experimentVerdicts[gateKey] : null;
    if (verdict === 'refuted') continue;
    if (verdict === 'confirmed') c.confidence = Math.min(0.95, c.confidence * 1.25);

    c.score = round(c.impact * c.confidence * c.ease, 4);

    // Measured track record from the recommendation ledger. Suppression needs
    // repeated evidence (metric deltas are noisy) — one flat week is not a
    // verdict, three is a pattern. Mixed records leave the score untouched.
    const hist = outcomeHistory[basisKey(c.basis)];
    if (hist) {
      if (hist.noEffect >= 3 && hist.helped === 0) continue;
      if (hist.noEffect >= 2 && hist.helped === 0) c.score = round(c.score * 0.5, 4);
      else if (hist.helped >= 2 && hist.noEffect === 0) c.score = round(c.score * 1.2, 4);
    }

    const prev = byTitle.get(c.title);
    if (!prev || c.score > prev.score) byTitle.set(c.title, c);
  }

  return [...byTitle.values()]
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((c, i) => ({
      type: 'leverage',
      domains: c.domains,
      title: c.title,
      detail: c.detail,
      confidence: c.score,
      evidence: {
        auto: true,
        kind: 'leverage',
        rank: i + 1,
        score: c.score,
        impact: round(c.impact),
        actionConfidence: round(c.confidence),
        ease: round(c.ease),
        basis: c.basis,
        dedupKey: basisKey(c.basis),
      },
    }));
}

module.exports = { rankActions, OUTCOMES, LEVERS, basisKey };
