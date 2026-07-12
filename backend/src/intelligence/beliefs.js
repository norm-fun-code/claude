// Belief promotion — turns feedback signals that used to evaporate into
// durable, surfaceable knowledge (see store/beliefs.js + migration 040 for
// what belongs in the beliefs table and what deliberately doesn't).
//
// Pure pattern functions here take rows in and return belief specs out, so the
// inference rules are unit-testable without a database; promoteBeliefs() is
// the thin nightly orchestrator called from consolidate().
const beliefsStore = require('../store/beliefs');

// How many DISTINCT dismissed insights of one type before we call it a
// preference rather than a coincidence. Three separate "no thanks" taps on the
// same kind of card is a pattern the user typed with their thumb.
const DISMISSAL_PATTERN_MIN = 3;

// Human labels for insight types that show up in dismiss keys — fall back to
// the raw type name for anything unmapped, so a new insight type still
// produces a readable belief without a code change here.
const TYPE_LABEL = {
  subscription_review: 'subscription-review',
  spending_pattern: 'spending-trend',
  over_budget: 'over-budget',
  savings_rate: 'savings-rate',
  net_worth_path: 'net-worth-projection',
  subscriptions: 'subscriptions-summary',
  investments: 'portfolio',
};

/**
 * Pure: infer type-level preference beliefs from the dismissal ledger.
 * `dismissedRows` are store/dismissedInsights.listDismissed() rows
 * ({ dismiss_key: 'type|title-sans-numbers', title, dismissed_at }).
 * A type with >= minCount DISTINCT dismissed keys becomes one belief.
 */
function dismissalPatterns(dismissedRows = [], { minCount = DISMISSAL_PATTERN_MIN } = {}) {
  const byType = new Map();
  for (const r of dismissedRows) {
    const key = String(r?.dismiss_key || '');
    const sep = key.indexOf('|');
    if (sep <= 0) continue;
    const type = key.slice(0, sep);
    if (!byType.has(type)) byType.set(type, new Set());
    byType.get(type).add(key);
  }

  const out = [];
  for (const [type, keys] of byType) {
    if (keys.size < minCount) continue;
    const label = TYPE_LABEL[type] || type.replace(/_/g, '-');
    out.push({
      kind: 'dismissal_pattern',
      dedupKey: `dismissal:${type}`,
      statement:
        `They have dismissed ${keys.size} different ${label} insights — they generally don't want this kind of callout. ` +
        `Feature it sparingly and only when genuinely exceptional; never re-surface one they already dismissed.`,
      // Grows with evidence, saturating: 3 dismissals → 0.6, 6+ → capped 0.9.
      confidence: Math.min(0.9, 0.4 + keys.size * 0.08),
      evidence: { type, distinctDismissed: keys.size },
    });
  }
  return out;
}

// How many 'dismissed'/'ignored' outcomes on the SAME (domain,type,subject)
// before the attention policy's own outcome ledger calls it a preference —
// same bar as the legacy insight-dismissal pattern, same reasoning.
const OUTCOME_PATTERN_MIN = 3;

/**
 * Pure: infer SUBJECT-level preference beliefs from the attention policy's
 * outcome ledger (store/attention.js#outcomeCounts() rows:
 * {domain,type,subject,outcome,n}). Unlike dismissalPatterns() above (which
 * only sees wealth-insight dismissals, type-level), this reads outcomes for
 * EVERY event the policy has judged — any domain, any surface — and keys
 * per SUBJECT (e.g. "health:anomaly:hrv", not just "anomaly" in general), so
 * "they keep dismissing HRV anomaly pings specifically" doesn't get
 * flattened into a blanket "they don't want health anomalies" belief.
 * A subject needs >=3 negative outcomes AND negatives outnumbering positives
 * (accepted/completed) — mixed evidence produces no belief, same principle
 * as the leverage-ranking outcome weighting in store/recommendations.js.
 */
function attentionOutcomePatterns(outcomeRows = [], { minCount = OUTCOME_PATTERN_MIN } = {}) {
  const bySubject = new Map(); // "domain:type:subject" -> {negative, positive}
  for (const r of outcomeRows) {
    if (!r.domain || !r.type || !r.subject) continue;
    const key = `${r.domain}:${r.type}:${r.subject}`;
    const slot = bySubject.get(key) || { domain: r.domain, type: r.type, subject: r.subject, negative: 0, positive: 0 };
    const n = Number(r.n) || 0;
    if (r.outcome === 'dismissed' || r.outcome === 'ignored') slot.negative += n;
    else if (r.outcome === 'accepted' || r.outcome === 'completed') slot.positive += n;
    bySubject.set(key, slot);
  }

  const out = [];
  for (const [key, s] of bySubject) {
    if (s.negative < minCount || s.negative <= s.positive) continue;
    out.push({
      kind: 'dismissal_pattern',
      dedupKey: `dismissal:attn:${key}`,
      statement:
        `They have dismissed or ignored "${s.type}" alerts about ${s.subject} ${s.negative} times (vs ${s.positive} acted on) — ` +
        `this specific alert is not landing. Raise the bar before surfacing it again; a quieter mention in the brief beats another push.`,
      confidence: Math.min(0.9, 0.4 + s.negative * 0.08),
      evidence: { domain: s.domain, type: s.type, subject: s.subject, negative: s.negative, positive: s.positive },
    });
  }
  return out;
}

/**
 * Active dismissal_pattern beliefs, rendered as the multiplier map the
 * attention policy's judge() applies to a candidate event's value (see
 * attention.js's beliefMultiplierFor). Two lookup grains, both populated:
 *   'type:<insightType>'      — the legacy wealth-insight-dismissal beliefs
 *   '<eventType>:<subject>'   — the new, precise attention-outcome beliefs
 * A belief that says "don't want this" LOWERS the multiplier (dampens
 * scoring); confidence maps linearly to how much, floored at 0.4 so a
 * dampened event still reaches add_to_brief rather than fully vanishing.
 */
async function beliefMultipliers() {
  const map = new Map();
  try {
    const rows = await beliefsStore.listActive({ kinds: ['dismissal_pattern'] });
    for (const b of rows) {
      const multiplier = Math.max(0.4, 1 - (b.confidence ?? 0.5) * 0.65);
      if (b.evidence?.type && b.evidence?.distinctDismissed != null) {
        map.set(`type:${b.evidence.type}`, multiplier);
      }
      if (b.evidence?.type && b.evidence?.subject != null) {
        map.set(`${b.evidence.type}:${b.evidence.subject}`, multiplier);
      }
    }
  } catch { /* fail-open: no personalization this run, never fatal */ }
  return map;
}

// ---- User-statement extraction (the one LLM step in the learning layer) ----

const EXTRACT_SYSTEM =
  'You extract DURABLE knowledge about a person from their own journal entries. ' +
  'Durable means it will still be true months from now: a standing preference ("I skip cold showers when I\'m sick"), ' +
  'a constraint ("Friday evenings are Sabbath — never schedule over them"), a correction of an assumption, a stable fact about their life or routine. ' +
  'NOT durable (never extract): transient states (sick this week, tired today, busy day), one-off events, goals or plans, moods, metrics, anything already captured in the EXISTING list. ' +
  'Most days contain nothing durable — an empty array is the normal, correct answer. ' +
  'Return ONLY a JSON array (no markdown, no commentary). Each item: ' +
  '{"slug": "short-stable-kebab-case-id", "statement": "one plain third-person sentence, e.g. \'They skip cold showers when sick — an explained pause, not a lapse.\'"}';

function buildExtractPrompt(entries, existingStatements) {
  const journal = entries.map((e) => `- [${e.entry_date}] ${String(e.text).slice(0, 500)}`).join('\n');
  const existing = existingStatements.length
    ? `EXISTING (already captured — do NOT repeat these or restate them differently):\n${existingStatements.map((s) => `- ${s}`).join('\n')}\n\n`
    : '';
  return `${existing}RECENT JOURNAL ENTRIES:\n${journal}`;
}

/** Pure: sanitize/validate the LLM's extraction output into belief specs. */
function parseExtractedStatements(parsed) {
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const item of parsed.slice(0, 5)) {
    const statement = typeof item?.statement === 'string' ? item.statement.trim() : '';
    const rawSlug = typeof item?.slug === 'string' ? item.slug : '';
    const slug = rawSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (!statement || statement.length < 10 || !slug) continue;
    out.push({
      kind: 'user_statement',
      dedupKey: `stated:${slug}`,
      statement: statement.slice(0, 400),
      confidence: 0.85, // they said it themselves — high, but the LLM extracted it, so not 1.0
      evidence: { source: 'day_journal_extraction' },
    });
  }
  return out;
}

/**
 * LLM pass over the last couple of days' journal entries: anything durable
 * the user stated becomes a user_statement belief. Gated to only run when
 * fresh entries exist (so a quiet day costs zero LLM calls), and the model
 * sees existing statements so re-runs don't re-extract rephrased duplicates.
 */
async function extractStatementBeliefs() {
  const dayJournal = require('../store/dayJournal');
  const entries = await dayJournal.recent({ days: 2, limit: 10 });
  if (!entries.length) return { extracted: 0, skipped: 'no_recent_entries' };

  const existing = await beliefsStore.listActive({ kinds: ['user_statement'] });
  const prompt = buildExtractPrompt(entries, existing.map((b) => b.statement));

  const llm = require('../llm');
  const { extractJson } = require('../llm/parseJson');
  const text = await llm.generateText({ system: EXTRACT_SYSTEM, prompt, temperature: 0, maxTokens: 600 });
  // extractJson returns null for text with no JSON in it — and JSON.parse(null)
  // quietly parses the string "null" rather than throwing, so check both paths
  // explicitly: anything that isn't an array is an unusable response.
  let parsed;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) return { extracted: 0, skipped: 'unparseable_response' };

  let extracted = 0;
  for (const spec of parseExtractedStatements(parsed)) {
    const id = await beliefsStore.upsertBelief(spec);
    if (id != null) extracted++;
  }
  return { extracted };
}

/**
 * Nightly orchestrator: read feedback ledgers, upsert the inferred beliefs.
 * Additive-only by design — it never retires anything (retirement is a user
 * action or a future explicit pathway), and upsertBelief won't resurrect a
 * retired row. Fail-soft per source so one bad ledger can't sink consolidate.
 */
async function promoteBeliefs({ extractStatements = true } = {}) {
  const results = { promoted: 0, errors: [] };

  try {
    const dismissed = await require('../store/dismissedInsights').listDismissed();
    for (const spec of dismissalPatterns(dismissed)) {
      const id = await beliefsStore.upsertBelief(spec);
      if (id != null) results.promoted++;
    }
  } catch (err) {
    results.errors.push(`dismissals: ${err.message}`);
  }

  // Same promotion, sourced from the attention policy's own outcome ledger —
  // covers every domain the policy judges (health/wealth/wellbeing/…), not
  // just wealth-insight cards, and keys per SUBJECT for precision.
  try {
    const outcomes = await require('../store/attention').outcomeCounts();
    for (const spec of attentionOutcomePatterns(outcomes)) {
      const id = await beliefsStore.upsertBelief(spec);
      if (id != null) results.promoted++;
    }
  } catch (err) {
    results.errors.push(`attention_outcomes: ${err.message}`);
  }

  // The one LLM step — optional so ledger-only promotion stays cheap and
  // deterministic for callers/tests that don't want a model call.
  if (extractStatements) {
    try {
      const r = await extractStatementBeliefs();
      results.promoted += r.extracted;
    } catch (err) {
      results.errors.push(`statements: ${err.message}`);
    }
  }

  return results;
}

/**
 * Pure: render active beliefs as a self-model section, or '' when there are
 * none. Kinds are tagged so the LLM knows the provenance ([they told you] vs
 * [inferred from behavior]) and can weigh them accordingly.
 */
function composeBeliefsSection(beliefs = []) {
  const rows = beliefs.filter((b) => b?.statement);
  if (!rows.length) return '';
  const tag = { user_statement: 'they told you', dismissal_pattern: 'inferred from behavior', recommendation_outcome: 'measured' };
  const lines = rows.map((b) => `  • [${tag[b.kind] || b.kind}] ${b.statement}`);
  return (
    'WHAT NORMOS HAS LEARNED (durable knowledge from interactions and feedback — honor these; ' +
    'they do NOT expire with the recent-context window):\n' + lines.join('\n')
  );
}

module.exports = {
  dismissalPatterns, promoteBeliefs, composeBeliefsSection, DISMISSAL_PATTERN_MIN,
  extractStatementBeliefs, parseExtractedStatements, buildExtractPrompt,
  attentionOutcomePatterns, beliefMultipliers, OUTCOME_PATTERN_MIN,
};
