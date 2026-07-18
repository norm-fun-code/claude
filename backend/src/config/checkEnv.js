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

// Production Safety Gate (audit recommendation #1): in production, these are
// the three env vars a boot with any of them missing must never proceed
// past — DATABASE_URL (so the app can't silently fall back to a local dev
// DB that doesn't exist on the host), NORMOS_API_TOKEN (so the /api surface
// isn't unauthenticated on a public host), and NORMOS_ADMIN_TOKEN (so the
// destructive-admin/diagnostic surface isn't either). Previously DATABASE_URL
// was the only one that was actually fatal — the two tokens only warned,
// meaning a production deploy with no token set would boot and serve every
// request completely unauthenticated. Names only are ever logged below —
// never a value — so this can't leak a secret into build/deploy logs.
const REQUIRED_IN_PRODUCTION = ['DATABASE_URL', 'NORMOS_API_TOKEN', 'NORMOS_ADMIN_TOKEN'];

/**
 * Runs at server boot, before the app starts accepting requests (and before
 * migrations run or the HTTP server binds — see server.js's boot()). Exits
 * the process for any of REQUIRED_IN_PRODUCTION missing in production;
 * everything else — including no usable LLM — stays a loud warning, not a
 * crash, since large parts of the app (metrics, manual logging, wealth
 * tracking, the mobile client's non-AI tabs) work fine without one.
 */
function validateBootConfig() {
  const prod = process.env.NODE_ENV === 'production';

  if (prod) {
    const missing = REQUIRED_IN_PRODUCTION.filter((k) => !has(k));
    if (missing.length) {
      console.error(
        `\n⚠️  FATAL: NODE_ENV=production but required env var(s) are not set: ${missing.join(', ')}.\n` +
        'DATABASE_URL is required so the app can\'t silently fall back to postgres://normos:normos@' +
        'localhost:5432/normos (which does not exist on a production host). NORMOS_API_TOKEN and ' +
        'NORMOS_ADMIN_TOKEN are required so the API and admin/diagnostic surfaces never run ' +
        `unauthenticated on a public deploy. Set ${missing.join(', ')} and restart.\n`
      );
      process.exit(1);
    }
  }

  if (!hasChatLLM()) {
    console.warn(
      '[boot] No usable chat LLM configured (no ANTHROPIC_API_KEY, no GEMINI_API_KEY) — ' +
      'chat, voice, and the daily briefing will not work until one is set. The rest of the ' +
      'app (metrics, logging, wealth tracking) is unaffected.'
    );
  }
}

module.exports = { hasChatLLM, validateBootConfig };
