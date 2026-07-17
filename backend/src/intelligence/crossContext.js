// Cross-context insights — NormOS's differentiator.
//
// Most apps silo your life: a health app, a finance app, a habit tracker. NormOS
// sees all of it at once. The statistical engine (analyze.js) already finds
// cross-domain RELATIONSHIPS (sleep↔mood, habits↔HRV, activity↔recovery); this
// layer turns the strongest of them into genuinely SURPRISING, plain-language
// connections a person wouldn't naturally make — grounded in their real numbers
// and their self-model, never invented.
//
// Output is persisted as `cross_context` findings, so it flows into the Insights
// card automatically and into the brief + chat as context.
require('dotenv').config();
const llm = require('../llm');
const findingsStore = require('../store/findings');
const goalsStore = require('../store/goals');
const experimentsStore = require('../store/experiments');
const beliefsStore = require('../store/beliefs');
const { composeBeliefsSection } = require('./beliefs');
const { parseAndValidate } = require('../llm/parseJson');

// Finding types that are inherently cross-domain, plus the generic correlation
// flagged crossDomain by analyze(). These are the raw material.
const CROSS_TYPES = new Set(['habit_split', 'sleep_impact', 'activity_impact']);

/** Pull the cross-domain relationships worth synthesizing from open findings.
 *  Excludes all wealth-domain correlations — they are lifestyle confounds
 *  (people who sleep well / exercise tend to earn more, but the causal arrow
 *  doesn't run from your habits to your bank account in any actionable way).
 *  Also excludes any lag>=2 finding — analyze.js no longer generates these
 *  (a two-night-delayed effect is scientifically weak to claim from daily
 *  observational data), but this filter is a defense-in-depth backstop for
 *  any older persisted finding that predates that fix and hasn't been
 *  superseded yet. */
function selectCrossDomain(findings) {
  return findings.filter((f) => {
    if ((f.evidence?.lag ?? 0) >= 2) return false;
    if (CROSS_TYPES.has(f.type)) return true;
    if (f.type === 'correlation' && f.evidence?.crossDomain === true) {
      const { a, b } = f.evidence || {};
      // Drop any correlation that touches the wealth domain.
      if (a?.startsWith('wealth:') || b?.startsWith('wealth:')) return false;
      return true;
    }
    return false;
  });
}

/** Confidence for a generated cross-context insight, DERIVED from the source
 *  findings it's synthesized from — never a fixed constant. Averages each
 *  source finding's own confidence (already a real statistical quantity —
 *  effect size × significance for a correlation, effect size for a split),
 *  so a synthesis built from strong, well-confirmed relationships reads more
 *  confident than one built from thin, borderline ones. Falls back to a
 *  conservative 0.5 (not the old flat 0.7) when no source confidence is
 *  available at all. */
function deriveConfidence(relationships) {
  const vals = (relationships || [])
    .map((f) => f.confidence)
    .filter((c) => c != null && Number.isFinite(Number(c)))
    .map(Number);
  if (!vals.length) return 0.5;
  const avg = vals.reduce((sum, v) => sum + v, 0) / vals.length;
  return Math.round(Math.min(0.95, Math.max(0.1, avg)) * 1000) / 1000;
}

/**
 * Bug bash finding: this used to prepend the ENTIRE self-model text (built by
 * consolidate.js's buildModelText) into the Cross-Domain prompt — including
 * its "RECENT DAILY CONTEXT" block of up to 10 dated day-journal entries and
 * "ACTIVE CONTEXT" annotations. The LLM took a days-old dated entry ("slept
 * hot, twisting and turning") and rewrote it as "your last night's context"
 * inside what's supposed to be a DURABLE statistical-pattern insight — a
 * true historical relationship stated with a false current-tense claim.
 *
 * Cross-Domain Patterns describe durable relationships, not live episodic
 * state, so this builds a SEPARATE, purpose-built profile containing ONLY
 * what's actually durable — stable beliefs, confirmed/ruled-out experiments,
 * and long-term goals — gathered fresh from their own stores. Deliberately
 * NOT a filtered/regex-stripped copy of the full self-model text: prose
 * surgery on an already-composed narrative is exactly the kind of fragile,
 * unpredictable manipulation that let episodic content slip through in the
 * first place. day_journal itself is untouched — Ask, the brief, and
 * date-aligned analysis still read the full, undiminished history.
 */
async function buildDurableProfile() {
  const [goals, experiments, beliefs] = await Promise.all([
    goalsStore.listGoals({ status: 'active' }).then((rows) => rows.slice(0, 8)).catch(() => []),
    experimentsStore.listExperiments().catch(() => []),
    beliefsStore.listActive().catch(() => []),
  ]);

  const lines = [];

  if (goals.length) {
    const goalLines = goals.map((g) => {
      const tgt = g.target_value != null ? ` → target ${g.target_value}${g.unit ? ` ${g.unit}` : ''}` : '';
      const by = g.target_date ? ` by ${new Date(g.target_date).toISOString().slice(0, 10)}` : '';
      return `${g.title}${tgt}${by}`;
    });
    lines.push(`LONG-TERM GOALS: ${goalLines.join(' · ')}`);
  }

  const completed = experiments.filter((e) => e.status === 'completed' && e.verdict);
  const proven = completed.filter((e) => e.verdict === 'confirmed');
  const ruledOut = completed.filter((e) => e.verdict === 'refuted');
  const expPct = (e) => (e.result?.pctChange != null ? ` (${e.result.pctChange > 0 ? '+' : ''}${Math.round(e.result.pctChange * 100)}% on ${e.metric})` : '');
  if (proven.length) {
    lines.push(
      `PROVEN ON THEM (self-tested experiments CONFIRMED on their own data — cite as proof, not association):\n` +
        proven.slice(0, 5).map((e) => `  ✓ "${e.hypothesis}"${expPct(e)}`).join('\n')
    );
  }
  if (ruledOut.length) {
    lines.push(
      `RULED OUT (self-tested, showed no effect on THEM):\n` +
        ruledOut.slice(0, 5).map((e) => `  ✗ "${e.hypothesis}"${expPct(e)}`).join('\n')
    );
  }

  const beliefsSection = composeBeliefsSection(beliefs);
  if (beliefsSection) lines.push(beliefsSection);

  return lines.join('\n\n');
}

const SYSTEM = `You are NormOS — the user's chief of staff and personal data scientist.
Your edge is that you see EVERY domain of their life at once: health, sleep, habits, mood/energy/focus, money, and the ideas in their library. Most tools silo these; you connect them.

You are given statistical RELATIONSHIPS found in their own data. Write the 1-3 most useful cross-context insights — ones grounded in their personal numbers that show the MAGNITUDE of a real pattern. Apply these rules:

INCLUDE (all worth surfacing when the numbers are personal and specific):
- Sleep quality → next-day energy, mood, or focus: THIS IS VALUABLE. Show the user exactly how much (e.g. "38% higher energy after best nights"). The personal magnitude is the insight, not the general principle.
- Habit → health/recovery connections: cold shower days vs others, TM days vs others, with real numbers
- Heavy meeting days → missed exercise, lower mood, worse next-day recovery (calendar is an input the world imposes; show how it hits you)
- Eating habits → mood or energy trajectory
- Any cross-domain finding where the numbers tell a clear personal story

EXCLUDE — filter these out:
- More sleep → better sleep score (definitional, within-health tautology)
- ANY connection involving money, spending, net worth, income, or financial metrics — all wealth correlations are lifestyle confounds with no actionable causal arrow
- Generic statements without personal numbers ("you feel better when you sleep more" without data)
- Anything that doesn't cross at least two of these domains: health, wellbeing, habits, productivity
- Any pattern where YOUR HABITS appear to predict meeting load / calendar density — the calendar is set by external forces (colleagues, clients, work schedules), not driven by whether you exercised. Only show meeting load as a DRIVER of health/habit/mood outcomes, never as an OUTCOME of them.

FORMAT rules:
- Phrase as "tends to / is associated with", never as causal fact
- Always name the specific personal numbers (e.g. "3.9/5 vs 2.8/5", "58ms vs 46ms")
- Be concrete about the lever ("on your TM days" not "when you meditate more")

TEMPORAL GROUNDING — CRITICAL:
Every relationship below is a STATISTICAL PATTERN aggregated across weeks of their data — it is NOT something that happened today, last night, or is happening again right now. Describe it as a standing tendency ("tends to", "on nights when", "historically"), never as a live, current-tense event.
Never write "today," "last night," "currently," "right now," "again," or "playing out" — nothing in this context is a dated, moment-specific event, so any such phrase would be invented, not grounded. If a sentence you're about to write implies something is happening right now or happened recently, rewrite it as the general pattern instead.
Return ONLY valid JSON.`;

/** Pure: build the generation prompt from relationships + the durable profile
 *  (stable beliefs, confirmed experiments, long-term goals — see
 *  buildDurableProfile; deliberately NOT the full self-model, which carries
 *  dated, episodic day-journal content that has no place in a durable-pattern
 *  prompt). */
function buildPrompt(relationships, durableProfileText) {
  const relBlock = relationships
    .map((f, i) => `${i + 1}. [${(f.domains || []).join('+') || f.type}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}`)
    .join('\n');

  return `${durableProfileText ? durableProfileText + '\n\n---\n\n' : ''}CROSS-DOMAIN RELATIONSHIPS FOUND IN THEIR DATA:
${relBlock}

Write the 1-3 most surprising, useful cross-context insights as JSON:
{
  "insights": [
    {
      "headline": "a short, punchy connection (max ~8 words), e.g. 'Late nights tend to flatten your next-day focus' (non-financial and associative, per the rules above)",
      "insight": "2-3 sentences: the connection, the numbers behind it, and the one lever that moves it. Plain language.",
      "domains": ["the", "domains", "involved"]
    }
  ]
}
Only include insights you can ground in the relationships above. If nothing is genuinely cross-context, return {"insights": []}.`;
}

/**
 * Generate cross-context insights and persist them as `cross_context` findings.
 * Supersedes prior auto cross_context findings first so the set stays current.
 * Best-effort: returns { generated, insights } and never throws into callers.
 */
async function generateCrossContext({ minRelationships = 2 } = {}) {
  let open = [];
  try {
    open = await findingsStore.listFindings({ status: 'open', limit: 200 });
  } catch (err) {
    console.error('[crossContext] findings load failed:', err.message);
    return { generated: 0, insights: [] };
  }

  const relationships = selectCrossDomain(open);
  // Not enough cross-domain signal yet — don't fabricate connections.
  if (relationships.length < minRelationships) {
    // Still clear stale ones so we don't show yesterday's insights on thin data.
    await findingsStore.supersedeAuto(['cross_context']).catch(() => {});
    return { generated: 0, insights: [], reason: 'insufficient cross-domain data' };
  }

  let durableProfileText = '';
  try { durableProfileText = await buildDurableProfile(); } catch { /* optional */ }

  let text = '';
  try {
    text = await llm.generateText({
      system: SYSTEM,
      prompt: buildPrompt(relationships, durableProfileText),
      temperature: 0.5,
      maxTokens: 900,
    });
  } catch (err) {
    console.error('[crossContext] generation failed:', err.message);
    return { generated: 0, insights: [] };
  }

  const validated = parseAndValidate(text, {
    label: 'cross-context',
    validate: (parsed) => (Array.isArray(parsed?.insights) ? parsed.insights : null),
  });
  // Each item still needs its own headline/insight before it's usable —
  // Array.isArray(parsed.insights) alone doesn't guarantee well-formed items.
  const insights = (validated ?? []).filter((ins) => ins?.headline && ins?.insight).slice(0, 3);
  if (!insights.length) {
    await findingsStore.supersedeAuto(['cross_context']).catch(() => {});
    return { generated: 0, insights: [] };
  }

  // Replace the prior set atomically-ish: supersede old, insert new.
  await findingsStore.supersedeAuto(['cross_context']).catch(() => {});

  let created = 0;
  for (const ins of insights) {
    if (!ins?.headline || !ins?.insight) continue;
    const domains = Array.isArray(ins.domains) && ins.domains.length
      ? ins.domains
      : [...new Set(relationships.flatMap((f) => f.domains || []))];
    try {
      const basisRelationships = relationships.slice(0, 8);
      await findingsStore.createFinding({
        type: 'cross_context',
        domains,
        title: String(ins.headline).slice(0, 140),
        detail: String(ins.insight).slice(0, 600),
        confidence: deriveConfidence(basisRelationships),
        evidence: {
          auto: true,
          kind: 'cross_context',
          // Structured, not just title strings — preserves each source
          // finding's actual lag/confidence through this layer so a
          // downstream consumer (leverage.js, an audit, a future dashboard)
          // can tell a same-day synthesis from a next-day one instead of
          // losing that distinction the moment it becomes prose.
          basis: basisRelationships.map((f) => ({
            title: f.title,
            type: f.type,
            lag: f.evidence?.lag ?? 0,
            confidence: Number.isFinite(Number(f.confidence)) ? Number(f.confidence) : null,
          })),
          generatedAt: new Date().toISOString(),
        },
      });
      created += 1;
    } catch (err) {
      console.error('[crossContext] persist failed:', err.message);
    }
  }

  if (created) console.log(`[crossContext] wrote ${created} cross-context insight(s)`);
  return { generated: created, insights };
}

module.exports = { generateCrossContext, selectCrossDomain, buildPrompt, buildDurableProfile, deriveConfidence };

if (require.main === module) {
  const { pool } = require('../db');
  generateCrossContext()
    .then((r) => {
      console.log(`\n--- ${r.generated} CROSS-CONTEXT INSIGHT(S) ---\n`);
      for (const i of r.insights) console.log(`• ${i.headline}\n  ${i.insight}\n`);
      if (r.reason) console.log(`(${r.reason})`);
    })
    .catch((err) => { console.error('Cross-context failed:', err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
