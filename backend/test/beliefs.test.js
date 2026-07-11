// Belief promotion rules (pure) — the inference layer that turns feedback
// signals into durable knowledge. A learning-loop audit found that repeated
// dismissals of the same insight TYPE taught the system nothing (each insight
// had to be dismissed individually, forever); dismissalPatterns() is the fix:
// >= 3 distinct dismissed insights of one type become a type-level preference
// belief that every surface then honors via the self-model.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dismissalPatterns, composeBeliefsSection } = require('../src/intelligence/beliefs');

const row = (key) => ({ dismiss_key: key, title: null, dismissed_at: new Date() });

test('three distinct dismissals of one type become a single type-level belief', () => {
  const out = dismissalPatterns([
    row('subscription_review|review honda financial is yr'),
    row('subscription_review|review netflix is yr'),
    row('subscription_review|review spotify is yr'),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'dismissal_pattern');
  assert.equal(out[0].dedupKey, 'dismissal:subscription_review');
  assert.match(out[0].statement, /dismissed 3 different subscription-review insights/);
});

test('two dismissals are a coincidence, not a pattern — no belief', () => {
  const out = dismissalPatterns([
    row('over_budget|dining out over budget'),
    row('over_budget|taxi over budget'),
  ]);
  assert.equal(out.length, 0);
});

test('the SAME insight dismissed is one distinct key — repeat dismissals of one card never fabricate a pattern', () => {
  // dismiss() is ON CONFLICT DO NOTHING so true duplicates can't exist in the
  // table, but the pure function must also be safe if handed duplicates.
  const out = dismissalPatterns([
    row('spending_pattern|clothing trending above your usual'),
    row('spending_pattern|clothing trending above your usual'),
    row('spending_pattern|clothing trending above your usual'),
  ]);
  assert.equal(out.length, 0, 'one distinct insight, however many rows, is not a type-level pattern');
});

test('types accumulate independently and confidence grows with evidence, capped', () => {
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(row(`subscription_review|merchant ${'x'.repeat(i + 1)}`));
  rows.push(row('over_budget|dining'));
  const out = dismissalPatterns(rows);
  assert.equal(out.length, 1, 'only subscription_review crossed the threshold');
  assert.ok(out[0].confidence <= 0.9, 'confidence saturates at 0.9');
  assert.ok(out[0].confidence > 0.6, 'more evidence -> more confidence');
  assert.equal(out[0].evidence.distinctDismissed, 8);
});

test('malformed dismiss keys (no type separator) are skipped, not crashed on', () => {
  const out = dismissalPatterns([row('no-separator-here'), row(''), row(null)]);
  assert.equal(out.length, 0);
});

test('composeBeliefsSection renders provenance tags and returns empty string for no beliefs', () => {
  assert.equal(composeBeliefsSection([]), '');
  const section = composeBeliefsSection([
    { kind: 'user_statement', statement: 'They skip cold showers when sick — an explained pause, not a lapse.' },
    { kind: 'dismissal_pattern', statement: 'They have dismissed 4 different subscription-review insights.' },
  ]);
  assert.match(section, /WHAT NORMOS HAS LEARNED/);
  assert.match(section, /\[they told you\] They skip cold showers when sick/);
  assert.match(section, /\[inferred from behavior\] They have dismissed 4/);
  assert.match(section, /do NOT expire/);
});

// The self-model is the delivery vehicle: every surface (brief, Ask, weekly
// review) reads the self-model text, so beliefs landing there is what makes
// them durable *in effect*, not just durable in a table nobody reads.
test('buildModelText includes the beliefs section when beliefs exist, omits it when none', () => {
  const { buildModelText } = require('../src/intelligence/consolidate');
  const base = {
    wellbeing: {}, health: {}, habits: {}, wealth: {},
    goals: [], experiments: { completed: [], running: [] },
    findings: { correlations: [], leverage: [] },
    annotations: [], intention: null, dayContext: [],
  };
  const withBeliefs = buildModelText({
    ...base,
    beliefs: [{ kind: 'user_statement', statement: 'Sabbath evenings are protected time — never frame them as calendar load.' }],
  });
  assert.match(withBeliefs, /WHAT NORMOS HAS LEARNED/);
  assert.match(withBeliefs, /Sabbath evenings are protected time/);

  const without = buildModelText({ ...base, beliefs: [] });
  assert.doesNotMatch(without, /WHAT NORMOS HAS LEARNED/);
});
