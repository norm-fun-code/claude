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
const selfModelStore = require('../store/selfModel');
const { extractJson } = require('../services/briefing-ai');

// Finding types that are inherently cross-domain, plus the generic correlation
// flagged crossDomain by analyze(). These are the raw material.
const CROSS_TYPES = new Set(['habit_split', 'sleep_impact', 'activity_impact']);

// Wealth balance-sheet metrics are structural (driven by income, compound growth,
// market moves) not by short-term behavior levers, so correlations with them are
// lifestyle confounds, not actionable cross-context insights. Filter them out so
// "walk more → higher net worth" never surfaces as a cross-context insight.
const WEALTH_STRUCTURAL = new Set(['wealth:net_worth', 'wealth:net_cashflow']);

/** Pull the cross-domain relationships worth synthesizing from open findings. */
function selectCrossDomain(findings) {
  return findings.filter((f) => {
    if (CROSS_TYPES.has(f.type)) return true;
    if (f.type === 'correlation' && f.evidence?.crossDomain === true) {
      // Drop correlations where either side is a structural wealth metric.
      const { a, b } = f.evidence || {};
      if (WEALTH_STRUCTURAL.has(a) || WEALTH_STRUCTURAL.has(b)) return false;
      return true;
    }
    return false;
  });
}

const SYSTEM = `You are NormOS — the user's chief of staff and personal data scientist.
Your edge is that you see EVERY domain of their life at once: health, sleep, habits, mood/energy/focus, money, and the ideas in their library. Most tools silo these; you connect them.

You are given statistical RELATIONSHIPS already found in their own data across domains. Write the few most genuinely SURPRISING, USEFUL cross-context insights — the "huh, I never connected those" kind. Rules:
- Ground EVERY claim in the relationships provided. Never invent a number or a link that isn't there.
- Favor connections that span DIFFERENT domains (e.g. sleep→spending, exercise→focus, a habit→recovery) over same-domain ones.
- Correlation is not causation — phrase as "tends to / is associated with", and where it's actionable, name the lever.
- Be specific and concrete. No horoscope vagueness, no flattery.
Return ONLY valid JSON.`;

/** Pure: build the generation prompt from relationships + self-model. */
function buildPrompt(relationships, selfModelText) {
  const relBlock = relationships
    .map((f, i) => `${i + 1}. [${(f.domains || []).join('+') || f.type}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}`)
    .join('\n');

  return `${selfModelText ? selfModelText + '\n\n---\n\n' : ''}CROSS-DOMAIN RELATIONSHIPS FOUND IN THEIR DATA:
${relBlock}

Write the 1-3 most surprising, useful cross-context insights as JSON:
{
  "insights": [
    {
      "headline": "a short, punchy connection (max ~8 words), e.g. 'Short sleep quietly drives your spending'",
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

  let selfModelText = '';
  try { selfModelText = (await selfModelStore.latestModelText()) ?? ''; } catch { /* optional */ }

  let parsed = null;
  try {
    const text = await llm.generateText({
      system: SYSTEM,
      prompt: buildPrompt(relationships, selfModelText),
      temperature: 0.5,
      maxTokens: 900,
    });
    parsed = extractJson(text);
  } catch (err) {
    console.error('[crossContext] generation failed:', err.message);
    return { generated: 0, insights: [] };
  }

  const insights = Array.isArray(parsed?.insights) ? parsed.insights.slice(0, 3) : [];
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
      await findingsStore.createFinding({
        type: 'cross_context',
        domains,
        title: String(ins.headline).slice(0, 140),
        detail: String(ins.insight).slice(0, 600),
        confidence: 0.7,
        evidence: {
          auto: true,
          kind: 'cross_context',
          basis: relationships.slice(0, 8).map((f) => f.title),
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

module.exports = { generateCrossContext, selectCrossDomain, buildPrompt };

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
