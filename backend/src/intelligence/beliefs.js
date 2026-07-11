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

/**
 * Nightly orchestrator: read feedback ledgers, upsert the inferred beliefs.
 * Additive-only by design — it never retires anything (retirement is a user
 * action or a future explicit pathway), and upsertBelief won't resurrect a
 * retired row. Fail-soft per source so one bad ledger can't sink consolidate.
 */
async function promoteBeliefs() {
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

module.exports = { dismissalPatterns, promoteBeliefs, composeBeliefsSection, DISMISSAL_PATTERN_MIN };
