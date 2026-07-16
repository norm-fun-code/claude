// "From your library", done right. Surface the ONE highlight from the user's own
// reading library that genuinely speaks to what they're living/working through
// right now — by semantic search over their current situation (goals, life
// context, wellbeing) — and explain WHY now in one specific line. When nothing is
// a strong match it returns no reason, so the card shows an honest factual frame
// instead of a false "surfaced for you" claim. Never matches against the daily
// quote (which produced the same-author/same-idea redundancy).
require('dotenv').config();
const llm = require('../llm');
const documentsStore = require('../store/documents');
const surfacedStore = require('../store/surfaced');
const { extractJson, parseAndValidate } = require('../llm/parseJson');
const { localDayBoundsUtc } = require('../util/date');
const { filterEligible } = require('./context-semantics');

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Semantic-search phrase from the user's current situation (NOT the quote). */
function buildRelevanceQuery({ goals = [], lifeContext = [], themes = '' } = {}) {
  const parts = [];
  if (goals.length) parts.push(`Working toward: ${goals.slice(0, 5).join('; ')}`);
  if (lifeContext.length) parts.push(`Currently: ${lifeContext.slice(0, 4).join('; ')}`);
  if (themes) parts.push(themes);
  return parts.join('. ') || 'growth, focus, resilience, building something meaningful';
}

const SYSTEM =
  'You are the editor of a personal "wisdom" feed. Given a person\'s CURRENT ' +
  'situation and a few candidate highlights from their own reading library, pick ' +
  'the ONE that most genuinely speaks to what they are living or working through ' +
  'right now, and explain the connection in one short, specific line. Be honest: if ' +
  "none is a strong, non-generic match, say so — never force a connection. Return ONLY JSON.";

function buildPrompt(context, candidates) {
  const list = candidates
    .map((h, i) => `[${i}] "${truncate(h.content, 280)}"${h.author ? ` — ${h.author}` : ''}${h.title ? ` (${h.title})` : ''}`)
    .join('\n');
  return (
    `CURRENT SITUATION:\n${context}\n\nCANDIDATE HIGHLIGHTS:\n${list}\n\n` +
    `Return JSON: {"index": <number of the best match>, ` +
    `"reason": "<one specific line, max ~110 chars, naming the real connection — e.g. \\"You're prepping the raise — Klaff on why neediness reads as weakness\\">", ` +
    `"relevance": "high" | "medium" | "low"}. ` +
    `Use "low" when the best candidate is only a generic or loose fit; then leave reason empty. ` +
    `TIMING: situation entries are dated (today/yesterday) — use only the timing given, never phrases like "last night" for anything not dated today/yesterday, and never invent recency.`
  );
}

/** Active goal titles + recent life-context annotations — the user's situation. */
async function gatherSituation() {
  const out = { goals: [], lifeContext: [] };
  try {
    const { rows } = await require('../db').query(
      `SELECT title FROM goals WHERE status = 'active' LIMIT 8`
    );
    out.goals = rows.map((r) => r.title).filter(Boolean);
  } catch { /* goals optional */ }
  try {
    const annotationsStore = require('../store/annotations');
    // Only the last 48h — transient somatic context (a heavy meal, a drink, a
    // hot room) is stale after a night or two, and an undated week-old tag
    // reads as "last night" in the surfaced reason. Each entry carries its
    // actual recency so the model can't invent timing.
    const tz = process.env.TZ || 'America/New_York';
    const { start } = localDayBoundsUtc(tz, new Date(Date.now() - 24 * 60 * 60 * 1000));
    const active = await annotationsStore.overlapping(start, new Date());
    const todayYmd = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    // 'general' purpose — a retraction/retired annotation must not seed the
    // "why this speaks to you right now" reasoning either.
    out.lifeContext = filterEligible(active, { purpose: 'general' })
      .map((a) => {
        const label = a.label || a.category;
        if (!label) return null;
        const when = new Date(a.start_ts).toLocaleDateString('en-CA', { timeZone: tz }) === todayYmd ? 'today' : 'yesterday';
        return `${label} (${when})`;
      })
      .filter(Boolean)
      .slice(0, 5);
  } catch { /* annotations optional */ }
  return out;
}

/**
 * Returns { id, title, author, content, url, reason, relevance, similarity } for
 * the best-matching library highlight, or null. `themes` is an optional extra
 * search hint (e.g. low-wellbeing themes). `excludeAuthor` drops same-author hits
 * (avoids echoing the daily quote). Does NOT record the surface — the caller does
 * (so a same-day rebuild doesn't burn the 30-day no-repeat).
 */
async function buildRelevantHighlight({ themes = '', excludeAuthor = null } = {}) {
  const { goals, lifeContext } = await gatherSituation();
  const query = buildRelevanceQuery({ goals, lifeContext, themes });

  let vec;
  try { [vec] = await llm.embed([query]); } catch { return null; }
  if (!vec) return null;

  let hits = await documentsStore.searchSimilar(vec, { k: 30, domain: 'learning' });
  const seen = await surfacedStore.recentRefs('highlight', 30);
  hits = hits.filter((h) => !seen.has(String(h.id)));
  if (excludeAuthor) {
    const ea = String(excludeAuthor).toLowerCase();
    hits = hits.filter((h) => String(h.author || '').toLowerCase() !== ea);
  }
  if (!hits.length) return null;

  const candidates = hits.slice(0, 6);
  let pick = candidates[0];
  let reason = '';
  let relevance = 'medium';
  try {
    const text = await llm.generateText({
      system: SYSTEM, prompt: buildPrompt(query, candidates), temperature: 0.3, maxTokens: 200, jsonMode: true,
    });
    const picked = parseAndValidate(text, {
      label: 'relevant-highlight',
      validate: (parsed) => (Number.isInteger(parsed?.index) && candidates[parsed.index] ? parsed : null),
    });
    if (picked) {
      pick = candidates[picked.index];
      relevance = ['high', 'medium', 'low'].includes(picked.relevance) ? picked.relevance : 'medium';
      reason = relevance === 'low' ? '' : String(picked.reason || '').trim().slice(0, 140);
    }
  } catch { /* fall back to the top cosine hit with no reason → factual frame */ }

  return {
    id: pick.id,
    title: pick.title,
    author: pick.author,
    content: pick.content,
    url: pick.url,
    reason: reason || null,
    relevance,
    similarity: typeof pick.similarity === 'number' ? Math.round(pick.similarity * 100) / 100 : null,
  };
}

module.exports = { buildRelevantHighlight, buildRelevanceQuery, buildPrompt, extractJson, gatherSituation, SYSTEM };
