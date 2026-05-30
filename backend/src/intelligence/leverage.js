// Highest Leverage Action engine.
//
// Answers the core NormOS question: "what's the highest-leverage thing I can do
// right now?" It converts findings (trends + correlations) and off-track goals
// into concrete candidate actions, each scored by impact × confidence × ease,
// then ranked. Pure and deterministic so it's unit-testable; narrative polish
// can be layered on by the LLM later.
const cat = require('./catalog');

// Outcomes we want to move, and the levers we can directly pull.
const OUTCOMES = new Set([
  'wellbeing:mood',
  'wellbeing:energy',
  'wellbeing:focus',
  'health:hrv',
  'health:vo2_max',
  'wealth:net_worth',
]);

// lever metric -> { ease 0..1, more: phrase to increase, less: phrase to decrease }
const LEVERS = {
  'health:sleep_hours': { ease: 0.5, more: 'protect more sleep', less: 'cut excess time in bed' },
  'health:exercise_minutes': { ease: 0.5, more: 'train more', less: 'ease training load' },
  'health:steps': { ease: 0.7, more: 'walk more', less: 'walk less' },
  'health:mindful_minutes': { ease: 0.7, more: 'add mindfulness', less: 'cut mindfulness' },
  'productivity:meetings': { ease: 0.6, more: 'add meetings', less: 'cut meetings / protect focus blocks' },
};

// Relative importance per domain when estimating impact.
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

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function round(n, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// Action from a worsening trend: reverse the decline.
function fromTrend(f) {
  const ev = f.evidence || {};
  if (ev.kind !== 'trend' || ev.pctChange == null) return null;
  const { domain, metric } = splitKey(ev.metric);
  const good = cat.goodWhen(domain, metric);
  const worsening =
    (good === 'up' && ev.pctChange < 0) || (good === 'down' && ev.pctChange > 0);
  if (!worsening) return null;

  const label = cat.label(domain, metric);
  const impact = clamp01(Math.abs(ev.pctChange) / 0.4) * (DOMAIN_WEIGHT[domain] ?? 0.5);
  const confidence = clamp01(f.confidence ?? 0.5);
  const ease = LEVERS[ev.metric]?.ease ?? 0.5;

  return {
    title: `Reverse the decline in ${label}`,
    detail: `${label} is trending the wrong way (${Math.round(ev.pctChange * 100)}% over the window). Make it this week's focus.`,
    domains: [domain],
    impact,
    confidence,
    ease,
    basis: { kind: 'trend', metric: ev.metric },
  };
}

// Action from a lever↔outcome correlation: pull the lever in the helpful direction.
function fromCorrelation(f) {
  const ev = f.evidence || {};
  if (ev.kind !== 'correlation' || ev.r == null) return null;
  // Only act on correlations that survived the confirmation gate. Unconfirmed
  // candidates become experiment proposals instead of actions.
  if (ev.confirmed === false) return null;

  // Identify which side is the lever and which is the outcome.
  let lever, outcome;
  if (LEVERS[ev.a] && OUTCOMES.has(ev.b)) {
    lever = ev.a;
    outcome = ev.b;
  } else if (LEVERS[ev.b] && OUTCOMES.has(ev.a)) {
    lever = ev.b;
    outcome = ev.a;
  } else {
    return null;
  }

  const lv = splitKey(lever);
  const ov = splitKey(outcome);
  const leverLabel = cat.label(lv.domain, lv.metric);
  const outcomeLabel = cat.label(ov.domain, ov.metric);
  const direction = ev.r >= 0 ? 'more' : 'less';
  const phrase = LEVERS[lever][direction];

  const impact = clamp01(Math.abs(ev.r)) * (DOMAIN_WEIGHT[ov.domain] ?? 0.5);
  const confidence = clamp01(Math.abs(ev.r));
  const ease = LEVERS[lever].ease;
  const lag = ev.lag ? ` (effect seen ~${ev.lag}d later)` : '';

  return {
    title: `To improve ${outcomeLabel}, ${phrase}`,
    detail: `${leverLabel} and ${outcomeLabel} are ${ev.r >= 0 ? 'positively' : 'inversely'} associated (r=${ev.r})${lag}. Pull this lever and watch ${outcomeLabel}. Association, not proof — worth an experiment.`,
    domains: [...new Set([lv.domain, ov.domain])],
    impact,
    confidence,
    ease,
    basis: { kind: 'correlation', lever, outcome, r: ev.r },
  };
}

// Action from an off-track goal.
function fromGoal(goal, latestByKey = {}) {
  if (!goal.metric || goal.target_value == null) return null;
  const key = `${goal.domain}:${goal.metric}`;
  const current = latestByKey[key];
  if (current == null) return null;

  const baseline = goal.baseline_value ?? current;
  const denom = goal.target_value - baseline;
  const progress = denom === 0 ? 1 : (current - baseline) / denom;
  if (progress >= 1) return null; // already there

  const gap = clamp01(1 - progress);
  const impact = gap * (DOMAIN_WEIGHT[goal.domain] ?? 0.6);

  return {
    title: `Close the gap on: ${goal.title}`,
    detail: `${Math.round(progress * 100)}% to target (${cat.label(goal.domain, goal.metric)} ${round(current)} → ${round(goal.target_value)}${goal.target_date ? `, by ${goal.target_date}` : ''}).`,
    domains: [goal.domain],
    impact,
    confidence: 0.8,
    ease: 0.5,
    basis: { kind: 'goal', goalId: goal.id },
  };
}

/**
 * Pure: rank actions from findings + goals.
 * @returns leverage finding objects (type 'leverage'), highest score first.
 */
function rankActions(findings = [], { goals = [], latestByKey = {}, max = 5 } = {}) {
  const candidates = [];

  for (const f of findings) {
    const action = f.type === 'trend' ? fromTrend(f) : f.type === 'correlation' ? fromCorrelation(f) : null;
    if (action) candidates.push(action);
  }
  for (const g of goals) {
    const action = fromGoal(g, latestByKey);
    if (action) candidates.push(action);
  }

  // De-dupe by title, keep the strongest.
  const byTitle = new Map();
  for (const c of candidates) {
    c.score = round(c.impact * c.confidence * c.ease, 4);
    const prev = byTitle.get(c.title);
    if (!prev || c.score > prev.score) byTitle.set(c.title, c);
  }

  return [...byTitle.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((c, i) => ({
      type: 'leverage',
      domains: c.domains,
      title: c.title,
      detail: c.detail,
      confidence: c.score, // ranking score doubles as the finding's confidence
      evidence: {
        auto: true,
        kind: 'leverage',
        rank: i + 1,
        score: c.score,
        impact: round(c.impact),
        actionConfidence: round(c.confidence),
        ease: round(c.ease),
        basis: c.basis,
      },
    }));
}

module.exports = { rankActions, OUTCOMES, LEVERS };
