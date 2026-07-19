// Provider-neutral TTS router — the shared entrypoint brief-audio.js calls
// for BOTH Brief and Wisdom narration (so they always use the identical
// provider path, never two independently-drifting implementations).
//
// Why this exists: production evidence showed gemini-2.5-flash-preview-tts
// and gemini-2.5-pro-preview-tts both stalling for the full per-attempt
// timeout on a fresh Wisdom cache miss — a real script, not a trivial one —
// after working the previous night. A single-provider design has no way to
// route around a preview model having an off night. This router tries
// providers in order with a BOUNDED, shared-deadline budget per provider —
// never the old "up to ~25s serially per candidate" shape — so a failing
// primary still leaves real time for the fallback within the total request
// deadline (see computeProviderBudget).
'use strict';

const voiceService = require('./voice');
const openaiService = require('./ttsOpenai');

const VALID_MODES = new Set(['auto', 'openai', 'gemini']);

/** NORMOS_TTS_PROVIDER: 'auto' (default) | 'openai' | 'gemini'. An
 *  unrecognized value falls back to 'auto' rather than silently disabling
 *  narration. Read dynamically (not frozen at module load) so tests and an
 *  admin diagnostic can exercise every mode without re-requiring the module. */
function configuredMode() {
  const raw = String(process.env.NORMOS_TTS_PROVIDER || 'auto').toLowerCase();
  return VALID_MODES.has(raw) ? raw : 'auto';
}

/**
 * Pure: which providers to try, in order, for a given mode. 'auto' and
 * 'openai' both prefer OpenAI — the mature, non-preview endpoint that a live
 * probe (see probeAll/doctor) can confirm works for this key, per the audit
 * brief's "if the live OpenAI probe succeeds, make OpenAI the default"
 * — 'gemini' prefers Gemini instead. The OTHER provider always stays as a
 * fallback candidate in either mode: a single degraded provider should never
 * remove the safety net entirely (required: "OpenAI timeout/error falls back
 * to Gemini when configured", and the reverse). When OpenAI has no key
 * configured at all it's dropped from the order outright, rather than
 * wasting a bounded-budget slot on a call that would fail for a config
 * reason, not a live outage.
 */
function resolveProviderOrder(mode = configuredMode(), openaiConfigured = openaiService.isConfigured()) {
  const preferOpenaiFirst = mode !== 'gemini';
  const order = preferOpenaiFirst ? ['openai', 'gemini'] : ['gemini', 'openai'];
  return order.filter((p) => p !== 'openai' || openaiConfigured);
}

// The ONE bounded end-to-end deadline for the whole provider-fallback
// sequence — mirrors voice.js's own GEMINI_TTS_OVERALL_TIMEOUT_MS
// convention (that constant now bounds only a single provider's OWN
// internal candidate-model loop; this one bounds the router's total). Must
// stay comfortably under the mobile client's fetch timeout
// (useBriefAudio.ts's DEFAULT_TIMEOUT_MS, 55000ms) — same margin reasoning.
const TTS_OVERALL_TIMEOUT_MS = Number(process.env.TTS_OVERALL_TIMEOUT_MS || 40000);

/**
 * Pure: split whatever's left of the overall deadline evenly across the
 * remaining candidate providers, each ALSO capped at its own configured max
 * — a provider never gets MORE than its own sensible ceiling just because
 * it happens to be the only one left. This is what actually bounds the
 * total: two providers never each get the full per-provider max serially
 * (the old ~25s+25s shape); the sum is bounded by TTS_OVERALL_TIMEOUT_MS
 * regardless of how many candidates remain.
 */
function computeProviderBudget(remainingMs, remainingProviderCount, providerMaxMs) {
  if (remainingMs <= 0 || remainingProviderCount <= 0) return 0;
  const evenShare = Math.floor(remainingMs / remainingProviderCount);
  return Math.max(0, Math.min(evenShare, providerMaxMs));
}

function maxMsFor(provider) {
  return provider === 'openai' ? openaiService.DEFAULT_TIMEOUT_MS : Number(process.env.GEMINI_TTS_TIMEOUT_MS || 25000) * 2;
  // Gemini's OWN synthesize() may try up to 2 candidate models internally
  // (see voice.js's TTS_CANDIDATES) — its sensible per-provider ceiling here
  // is roughly double one model's per-attempt timeout, not just one
  // attempt's worth, so a legitimately-needed second-model fallback inside
  // Gemini isn't starved to near-zero budget when Gemini already has the
  // whole remaining share to itself (e.g. it's the only candidate, or it's
  // going last). synthesize()'s own internal deadline logic still bounds
  // each individual attempt further, exactly as it does today.
}

async function callProvider(provider, text, { voice, style, budgetMs }) {
  if (provider === 'openai') {
    const out = await openaiService.synthesize(text, { budgetMs });
    return { ...out, provider: 'openai' };
  }
  const out = await voiceService.synthesize(text, { voice, style, budgetMs });
  return { ...out, provider: 'gemini' };
}

/**
 * Synthesize with automatic, bounded-budget fallback between providers.
 * Never spends the full per-provider timeout on every candidate serially.
 * Throws only when every candidate provider failed (or none were
 * configured); the thrown message never includes a key or the transcript
 * text — each provider's own synthesize() already redacts those.
 */
async function synthesizeWithFallback(text, { voice, style } = {}) {
  const order = resolveProviderOrder();
  if (!order.length) throw new Error('TTS failed: no provider configured (set GEMINI_API_KEY and/or OPENAI_API_KEY)');
  const deadline = Date.now() + TTS_OVERALL_TIMEOUT_MS;
  let lastErr = null;
  for (let i = 0; i < order.length; i++) {
    const provider = order[i];
    const remaining = deadline - Date.now();
    const remainingCount = order.length - i;
    const budgetMs = computeProviderBudget(remaining, remainingCount, maxMsFor(provider));
    if (budgetMs < 1000) {
      console.error(`[tts router] overall ${TTS_OVERALL_TIMEOUT_MS}ms deadline leaves no budget for provider=${provider} — skipping`);
      continue;
    }
    try {
      return await callProvider(provider, text, { voice, style, budgetMs });
    } catch (err) {
      lastErr = err;
      console.error(`[tts router] provider=${provider} failed budgetMs=${budgetMs}: ${err.message}`);
    }
  }
  throw new Error(`TTS failed on every provider (${order.join(', ')}): ${lastErr?.message || 'no candidates attempted'}`);
}

/**
 * Static, network-free description of the CURRENT effective config — used
 * by brief-audio.js to build the cache_key identity (so a provider/model/
 * voice CHANGE invalidates old cached audio instead of silently serving
 * incompatible stale bytes — required: "Include provider/model/voice/script
 * hash in cache identity") and by the admin diagnostic.
 */
function describeConfig() {
  const order = resolveProviderOrder();
  const primary = order[0] || 'none';
  const model = primary === 'openai' ? openaiService.DEFAULT_MODEL : (process.env.GEMINI_TTS_MODEL || voiceService.TTS_CANDIDATES[0]);
  const voice = primary === 'openai' ? openaiService.DEFAULT_VOICE : voiceService.DEFAULT_VOICE;
  return { mode: configuredMode(), order, primary, model, voice };
}

/**
 * Independent, bounded live probe of BOTH providers — for the admin
 * diagnostic (required: "Make the diagnostic endpoint report both providers
 * independently"). Never throws; each provider's probe is fully isolated
 * from the other's outcome — one being unconfigured/down never affects the
 * other's report.
 */
async function probeAll(budgetMs = 8000) {
  const [openai, gemini] = await Promise.all([
    openaiService.probe(budgetMs).catch((err) => ({ ok: false, provider: 'openai', error: err.message })),
    (async () => {
      if (!process.env.GEMINI_API_KEY) return { ok: false, configured: false, provider: 'gemini', error: 'GEMINI_API_KEY not set' };
      const t0 = Date.now();
      try {
        const out = await voiceService.synthesize('This is a short narration test.', { budgetMs });
        return { ok: true, configured: true, provider: 'gemini', model: out.model, elapsedMs: Date.now() - t0, audioBytes: out.audio.length };
      } catch (err) {
        return { ok: false, configured: true, provider: 'gemini', elapsedMs: Date.now() - t0, error: err.message };
      }
    })(),
  ]);
  return { openai, gemini };
}

module.exports = {
  synthesizeWithFallback, resolveProviderOrder, computeProviderBudget, describeConfig, probeAll,
  configuredMode, TTS_OVERALL_TIMEOUT_MS,
};
