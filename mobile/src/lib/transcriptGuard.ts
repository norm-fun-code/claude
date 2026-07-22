// Pre-response audio-turn gate for Talk to NormOs.
//
// Bug: background noise or speaker echo was sometimes transcribed by the
// Realtime API as a tiny, plausible-looking utterance in some OTHER
// language — e.g. "お願いします。" — which then rendered as a real user
// bubble, triggered an assistant response, and could even drive a tool
// call/persist false context. gpt-4o-mini-transcribe will confidently
// transcribe a couple hundred milliseconds of room tone into SOMETHING; the
// fix is a deterministic classifier the client runs on every finalized
// spoken transcript BEFORE treating it as a real turn.
//
// Deliberately NOT a blacklist of known phantom phrases (that only ever
// covers phrases already seen) — this is a general English-session guard:
// reject transcripts that are empty, punctuation-only, predominantly written
// in a script that has no meaningful Latin/English content, or implausibly
// short in captured speech duration. Legitimate short commands ("yes", "no",
// "stop", "hey"), names, numbers, contractions, and accented Latin text
// ("café", "Renée") all pass — they're ordinary English-alphabet content,
// just brief.
//
// Pure and framework-free (no react-native-webrtc, no RN APIs) so it's
// directly unit-testable under plain Node — see transcriptGuard.test.ts.

export type ScriptCategory =
  | 'latin'
  | 'han'
  | 'hiragana'
  | 'katakana'
  | 'cyrillic'
  | 'hangul'
  | 'arabic'
  | 'greek'
  | 'hebrew'
  | 'thai'
  | 'other';

export type RejectionReason = 'empty' | 'punctuation_only' | 'unexpected_script' | 'too_short_duration';

export interface TranscriptGuardResult {
  accepted: boolean;
  /** Present only when accepted === false. */
  reason?: RejectionReason;
  /** The dominant non-Latin script found, only set for reason === 'unexpected_script'. */
  scriptCategory?: ScriptCategory;
  /** Count of "meaningful" characters (letters + digits) — safe to log, never the transcript itself. */
  charCount: number;
  /** Captured VAD speech_started -> speech_stopped duration, when available. */
  durationMs?: number | null;
}

export interface ClassifyOptions {
  /** BCP-47-ish language code the session was configured for. Only 'en'
   *  (the default) currently enforces the Latin/English script guard —
   *  a non-English session should not reject its own language's script. */
  language?: string;
  /** Captured speech_started -> speech_stopped duration in ms, when available. */
  speechDurationMs?: number | null;
  /** Below this, and only when speechDurationMs is actually known, the turn
   *  is rejected as an implausibly short noise blip. */
  minSpeechDurationMs?: number;
}

const DEFAULT_MIN_SPEECH_DURATION_MS = 150;

// Scripts checked via Unicode "Script" property escapes (ES2018+, supported
// by Node's V8 and Hermes) — no hand-rolled code-point range tables to keep
// in sync with Unicode updates.
const SCRIPT_TESTS: Array<[Exclude<ScriptCategory, 'other'>, RegExp]> = [
  ['latin', /\p{Script=Latin}/u],
  ['han', /\p{Script=Han}/u],
  ['hiragana', /\p{Script=Hiragana}/u],
  ['katakana', /\p{Script=Katakana}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['greek', /\p{Script=Greek}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['thai', /\p{Script=Thai}/u],
];
const ANY_LETTER_RE = /\p{L}/u;
const ANY_DIGIT_RE = /\p{Nd}/u;

function scriptOfChar(ch: string): ScriptCategory | null {
  for (const [name, re] of SCRIPT_TESTS) {
    if (re.test(ch)) return name;
  }
  if (ANY_LETTER_RE.test(ch)) return 'other';
  return null; // punctuation, symbol, whitespace, digit, combining mark, etc.
}

function isEnglishSession(language: string | undefined): boolean {
  if (!language) return true; // default assumption matches the session default
  return language.toLowerCase().startsWith('en');
}

/**
 * Classify one finalized spoken transcript. Pure function — no I/O, no
 * mutation of anything passed in.
 */
export function classifySpokenTranscript(rawText: string, opts: ClassifyOptions = {}): TranscriptGuardResult {
  const text = String(rawText ?? '').trim();
  const minSpeechDurationMs = opts.minSpeechDurationMs ?? DEFAULT_MIN_SPEECH_DURATION_MS;
  const durationMs = opts.speechDurationMs ?? null;

  if (!text) {
    return { accepted: false, reason: 'empty', charCount: 0, durationMs };
  }

  // Tally letters by script + digits, over code points (not UTF-16 code
  // units) so astral-plane characters aren't split into bogus surrogate halves.
  const scriptCounts: Partial<Record<ScriptCategory, number>> = {};
  let digitCount = 0;
  for (const ch of text) {
    if (ANY_DIGIT_RE.test(ch)) { digitCount++; continue; }
    const script = scriptOfChar(ch);
    if (script) scriptCounts[script] = (scriptCounts[script] || 0) + 1;
  }
  const latinCount = scriptCounts.latin || 0;
  const totalLetters = Object.values(scriptCounts).reduce((a, b) => a + (b || 0), 0);
  const charCount = totalLetters + digitCount;

  if (charCount === 0) {
    return { accepted: false, reason: 'punctuation_only', charCount: 0, durationMs };
  }

  // Only an English session enforces "must have meaningful Latin content" —
  // a session configured for another language shouldn't reject its own script.
  if (isEnglishSession(opts.language) && totalLetters > 0 && latinCount === 0) {
    let dominant: ScriptCategory = 'other';
    let dominantCount = -1;
    for (const [script, count] of Object.entries(scriptCounts) as Array<[ScriptCategory, number]>) {
      if (script === 'latin') continue;
      if ((count || 0) > dominantCount) { dominant = script; dominantCount = count || 0; }
    }
    return { accepted: false, reason: 'unexpected_script', scriptCategory: dominant, charCount, durationMs };
  }

  if (durationMs != null && durationMs < minSpeechDurationMs) {
    return { accepted: false, reason: 'too_short_duration', charCount, durationMs };
  }

  return { accepted: true, charCount, durationMs };
}

/** Format a rejection as a safe, content-free diagnostic line — reason,
 *  character count, detected script category, and speech duration only.
 *  Never the transcript text, never audio. */
export function describeRejection(result: TranscriptGuardResult): string {
  const parts = [`reason=${result.reason}`, `charCount=${result.charCount}`];
  if (result.scriptCategory) parts.push(`script=${result.scriptCategory}`);
  parts.push(`durationMs=${result.durationMs ?? 'unknown'}`);
  return parts.join(' ');
}
