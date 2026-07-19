// Real, production-safe short probe against whichever TTS provider(s) are
// actually configured in THIS environment (GEMINI_API_KEY / OPENAI_API_KEY)
// — deliberately NOT a mock. Per the audit requirement: "Do not add fake
// provider mocks as the only verification. Run a real production-safe
// short probe against the configured providers." A tiny (~30-char) script
// only, same as the admin /api/diag/tts endpoint's short probe — never a
// large or repeated call.
//
// Skips cleanly (not a failure) when NEITHER key is configured — this
// sandbox/CI's unit+integration test env intentionally never sets real
// provider secrets (see .github/workflows/ci.yml), so this test has no
// live provider to reach here. Run it locally, or in a deploy environment,
// with a real key set to get an actual pass/fail signal against the live
// service. See test/tts-provider.test.js for the deterministic, mocked
// coverage of the fallback/budget/cache-identity/logging behavior this
// test intentionally does NOT attempt to fake (a hung provider, a forced
// timeout) — those need control this test can't safely have over a real
// paid API call.
const test = require('node:test');
const assert = require('node:assert/strict');

const hasGemini = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
const hasOpenai = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
const SKIP_REASON = 'neither GEMINI_API_KEY nor OPENAI_API_KEY is set in this environment — '
  + 'set one and re-run to get a real pass/fail signal from the live provider(s)';

test(
  'live probe: at least one configured TTS provider synthesizes a short script successfully',
  { skip: !hasGemini && !hasOpenai ? SKIP_REASON : false },
  async () => {
    const ttsProvider = require('../../src/services/ttsProvider');
    const result = await ttsProvider.probeAll(10000);
    // Log only safe, non-secret fields — provider, model, ok, elapsed,
    // status/errCode — never a key or the script text itself.
    console.log('[tts live probe]', JSON.stringify({
      gemini: { ok: result.gemini.ok, configured: result.gemini.configured, elapsedMs: result.gemini.elapsedMs, model: result.gemini.model, status: result.gemini.status },
      openai: { ok: result.openai.ok, configured: result.openai.configured, elapsedMs: result.openai.elapsedMs, model: result.openai.model, status: result.openai.status },
    }));
    assert.ok(
      result.gemini.ok || result.openai.ok,
      `expected at least one configured provider to succeed a short live synthesis — gemini: ${JSON.stringify(result.gemini)}, openai: ${JSON.stringify(result.openai)}`
    );
  }
);

test(
  'live probe: OpenAI specifically synthesizes a short script via gpt-4o-mini-tts /v1/audio/speech',
  { skip: !hasOpenai ? 'OPENAI_API_KEY not set' : false },
  async () => {
    const openaiService = require('../../src/services/ttsOpenai');
    const result = await openaiService.probe(10000);
    console.log('[tts live probe] openai', JSON.stringify({ ok: result.ok, elapsedMs: result.elapsedMs, model: result.model, audioBytes: result.audioBytes, status: result.status }));
    assert.equal(result.ok, true, `expected the live OpenAI probe to succeed: ${JSON.stringify(result)}`);
    assert.ok(result.audioBytes > 0, 'a successful probe must actually return audio bytes, not just a 200');
  }
);

test(
  'live probe: Gemini specifically synthesizes a short script (for comparison against the OpenAI probe above)',
  { skip: !hasGemini ? 'GEMINI_API_KEY not set' : false },
  async () => {
    const voiceService = require('../../src/services/voice');
    const t0 = Date.now();
    const result = await voiceService.synthesize('This is a short narration test.', { budgetMs: 25000 });
    console.log('[tts live probe] gemini', JSON.stringify({ ok: true, elapsedMs: Date.now() - t0, model: result.model, audioBytes: result.audio.length }));
    assert.ok(result.audio.length > 0);
  }
);
