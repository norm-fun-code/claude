// Startup config validation — see the engineering review's #10. Of the
// ~115 env vars this app reads, almost none are truly fatal: the whole
// architecture is "lazy, per-feature degrade" (a missing Notion/Gmail/
// Monarch/Weather credential just disables that one integration, checked
// the moment it's used, never at boot). npm run doctor already reports on
// that in detail. This module covers the narrow slice that ISN'T safe to
// silently degrade — the two things that make the app either dangerously
// misconfigured (a prod deploy silently pointing at a local DB nobody is
// running) or pointless to have booted at all (no LLM means no chat, no
// briefing, nothing AI-driven works) — and is shared with doctor.js so
// there's exactly one definition of "is there a usable chat LLM," not two.
const has = (k) => Boolean(process.env[k] && process.env[k].trim());

/** True if at least one chat/reasoning LLM is actually usable. */
function hasChatLLM() {
  const provider = process.env.LLM_PROVIDER || (has('ANTHROPIC_API_KEY') ? 'anthropic' : 'gemini');
  if (provider === 'anthropic') return has('ANTHROPIC_API_KEY');
  return has('GEMINI_API_KEY');
}

/**
 * Runs at server boot, before the app starts accepting requests. Exits the
 * process only for the one misconfiguration that's actively dangerous in
 * production (silently falling back to a local DB nobody is running);
 * everything else — including no usable LLM — is a loud warning, not a
 * crash, since large parts of the app (metrics, manual logging, wealth
 * tracking, the mobile client's non-AI tabs) work fine without one.
 */
function validateBootConfig() {
  const prod = process.env.NODE_ENV === 'production';

  if (prod && !has('DATABASE_URL')) {
    console.error(
      '\n⚠️  FATAL: NODE_ENV=production but DATABASE_URL is not set — src/db/index.js would ' +
      'silently fall back to postgres://normos:normos@localhost:5432/normos, which does not ' +
      'exist on a production host. Set DATABASE_URL and restart.\n'
    );
    process.exit(1);
  }

  if (!hasChatLLM()) {
    console.warn(
      '[boot] No usable chat LLM configured (no ANTHROPIC_API_KEY, no GEMINI_API_KEY) — ' +
      'chat, voice, and the daily briefing will not work until one is set. The rest of the ' +
      'app (metrics, logging, wealth tracking) is unaffected.'
    );
  }

  if (!has('NORMOS_API_TOKEN') && prod) {
    console.warn(
      '[boot] NODE_ENV=production but NORMOS_API_TOKEN is not set — the /api surface is ' +
      'unauthenticated on what looks like a public deploy.'
    );
  }
}

module.exports = { hasChatLLM, validateBootConfig };
