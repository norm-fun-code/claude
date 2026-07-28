// Push-to-talk's transcript-quality guard — the backend equivalent of
// mobile/src/lib/transcriptGuard.ts's phantom-transcript classifier. Voice
// Realtime's guard runs client-side (the backend never sees a Realtime
// transcript until after the client already accepted it); push-to-talk's
// transcript, by contrast, DOES pass through this backend (routes/voice.js),
// so it gets its own instance of the same heuristic rather than trusting
// any non-empty STT output verbatim (the pre-existing behavior — see
// services/voice.js's transcribe(), which only ever signals "empty string").
//
// Mirrors transcriptGuard.ts's algorithm (same rejection reasons, same
// English-session script check) so the two surfaces reject the same class
// of noise/phantom output, even though they can't literally share a JS
// runtime across mobile/backend.
'use strict';

const SCRIPTS = ['Han', 'Hiragana', 'Katakana', 'Cyrillic', 'Hangul', 'Arabic', 'Greek', 'Hebrew', 'Thai'];

function countByScript(text) {
  const counts = { Latin: 0, Han: 0, Hiragana: 0, Katakana: 0, Cyrillic: 0, Hangul: 0, Arabic: 0, Greek: 0, Hebrew: 0, Thai: 0, other: 0 };
  let meaningful = 0;
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) meaningful++;
    else continue;
    if (/\p{Script=Latin}/u.test(ch)) counts.Latin++;
    else if (/\p{Script=Han}/u.test(ch)) counts.Han++;
    else if (/\p{Script=Hiragana}/u.test(ch)) counts.Hiragana++;
    else if (/\p{Script=Katakana}/u.test(ch)) counts.Katakana++;
    else if (/\p{Script=Cyrillic}/u.test(ch)) counts.Cyrillic++;
    else if (/\p{Script=Hangul}/u.test(ch)) counts.Hangul++;
    else if (/\p{Script=Arabic}/u.test(ch)) counts.Arabic++;
    else if (/\p{Script=Greek}/u.test(ch)) counts.Greek++;
    else if (/\p{Script=Hebrew}/u.test(ch)) counts.Hebrew++;
    else if (/\p{Script=Thai}/u.test(ch)) counts.Thai++;
    else counts.other++;
  }
  return { counts, meaningful };
}

/**
 * @param {string} rawText
 * @param {{ language?: string, minLength?: number }} [opts]
 * @returns {{ accepted: boolean, reason?: string }}
 */
function classifyTranscript(rawText, { language = 'en', minLength = 2 } = {}) {
  const text = String(rawText || '').trim();
  if (!text) return { accepted: false, reason: 'empty' };

  const { counts, meaningful } = countByScript(text);
  if (meaningful === 0) return { accepted: false, reason: 'punctuation_only' };

  const isEnglishSession = String(language || 'en').toLowerCase().startsWith('en');
  if (isEnglishSession && counts.Latin === 0) {
    const dominant = SCRIPTS.find((s) => counts[s] > 0) || 'other';
    return { accepted: false, reason: `unexpected_script:${dominant}` };
  }

  // A very short, non-Latin-dominant burst even when SOME Latin chars are
  // present (e.g. a 2-char transliteration artifact) is still suspicious for
  // an English session with weak evidence — reject rather than pass a
  // near-meaningless fragment into ask() as if it were a real utterance.
  if (isEnglishSession && meaningful < minLength && counts.Latin < meaningful) {
    return { accepted: false, reason: 'too_short_low_confidence' };
  }

  return { accepted: true };
}

module.exports = { classifyTranscript };
