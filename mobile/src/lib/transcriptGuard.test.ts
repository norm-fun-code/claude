// Regression tests for the phantom-Realtime-turn guard. Run via:
//   node --experimental-strip-types --test src/lib/transcriptGuard.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySpokenTranscript } from './transcriptGuard.ts';

// ── The exact reproduction ─────────────────────────────────────────────

test('rejects the exact お願いします。 reproduction as an unexpected script with no Latin content', () => {
  const result = classifySpokenTranscript('お願いします。');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'unexpected_script');
  assert.ok(result.scriptCategory, 'must report a detected script category for diagnostics');
  assert.notEqual(result.scriptCategory, 'latin');
});

// ── Other non-Latin phantom transcripts ─────────────────────────────────

test('rejects a Cyrillic phantom transcript', () => {
  const result = classifySpokenTranscript('Спасибо');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'unexpected_script');
  assert.equal(result.scriptCategory, 'cyrillic');
});

test('rejects a Han/Chinese phantom transcript', () => {
  const result = classifySpokenTranscript('谢谢你');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'unexpected_script');
  assert.equal(result.scriptCategory, 'han');
});

test('rejects a Hangul (Korean) phantom transcript', () => {
  const result = classifySpokenTranscript('감사합니다');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'unexpected_script');
  assert.equal(result.scriptCategory, 'hangul');
});

test('rejects an Arabic phantom transcript', () => {
  const result = classifySpokenTranscript('شكرا');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'unexpected_script');
  assert.equal(result.scriptCategory, 'arabic');
});

// ── Empty / punctuation-only ─────────────────────────────────────────────

test('rejects an empty transcript', () => {
  const result = classifySpokenTranscript('');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'empty');
  assert.equal(result.charCount, 0);
});

test('rejects a whitespace-only transcript', () => {
  const result = classifySpokenTranscript('   \n\t  ');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'empty');
});

test('rejects a punctuation-only transcript', () => {
  for (const text of ['...', '?!', '.', '—', '¿?']) {
    const result = classifySpokenTranscript(text);
    assert.equal(result.accepted, false, `"${text}" should be rejected`);
    assert.equal(result.reason, 'punctuation_only', `"${text}" should be punctuation_only`);
  }
});

// ── Normal English content is accepted ───────────────────────────────────

test('accepts a normal English paragraph', () => {
  const result = classifySpokenTranscript(
    "What's the plan for this afternoon? I want to make sure I've got enough time before my next meeting."
  );
  assert.equal(result.accepted, true);
  assert.equal(result.reason, undefined);
});

// ── Legitimate short commands ─────────────────────────────────────────────

test('preserves legitimate short commands: yes, no, stop, cancel, repeat, hey', () => {
  for (const word of ['Yes', 'No', 'Stop', 'Cancel', 'Repeat', 'Hey', 'yes.', 'No!']) {
    const result = classifySpokenTranscript(word);
    assert.equal(result.accepted, true, `"${word}" must remain usable`);
  }
});

test('preserves short commands even with a realistic captured duration', () => {
  const result = classifySpokenTranscript('Stop', { speechDurationMs: 260 });
  assert.equal(result.accepted, true);
});

// ── Names, numbers, contractions, accents, tricky sentences ──────────────

test('accepts "Tomorrow is the 9th of Av."', () => {
  const result = classifySpokenTranscript('Tomorrow is the 9th of Av.');
  assert.equal(result.accepted, true);
});

test('accepts accented Latin names', () => {
  for (const text of ['I met Renée for coffee.', 'Let\'s grab a café later.']) {
    const result = classifySpokenTranscript(text);
    assert.equal(result.accepted, true, `"${text}" must be accepted`);
  }
});

test('accepts contractions and numbers', () => {
  const result = classifySpokenTranscript("I can't believe it's already 3 o'clock.");
  assert.equal(result.accepted, true);
});

test('accepts an English sentence containing a foreign proper noun (has meaningful Latin content)', () => {
  const result = classifySpokenTranscript('My favorite restaurant is called 你好 Kitchen.');
  assert.equal(result.accepted, true, 'has meaningful Latin content alongside the foreign name, so it must not be rejected');
});

// ── Duration-gated rejection ───────────────────────────────────────────────

test('rejects an implausibly short noise turn when duration is known and below the threshold', () => {
  const result = classifySpokenTranscript('Thanks', { speechDurationMs: 40 });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'too_short_duration');
  assert.equal(result.durationMs, 40);
});

test('does not apply the duration gate when duration is unknown', () => {
  const result = classifySpokenTranscript('Hi', { speechDurationMs: undefined });
  assert.equal(result.accepted, true);
});

test('does not apply the duration gate when duration is null', () => {
  const result = classifySpokenTranscript('Hi', { speechDurationMs: null });
  assert.equal(result.accepted, true);
});

test('a custom minSpeechDurationMs threshold is respected', () => {
  const result = classifySpokenTranscript('Hi', { speechDurationMs: 100, minSpeechDurationMs: 50 });
  assert.equal(result.accepted, true, '100ms clears a lowered 50ms threshold');
});

// ── Non-English sessions don't enforce the Latin guard ────────────────────

test('a non-English session does not reject its own script', () => {
  const result = classifySpokenTranscript('お願いします。', { language: 'ja' });
  assert.equal(result.accepted, true);
});

test('an explicit "en" language still enforces the guard the same as the default', () => {
  const result = classifySpokenTranscript('お願いします。', { language: 'en' });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'unexpected_script');
});

// ── charCount is always a safe, content-free diagnostic ───────────────────

test('charCount reflects only letters+digits, safe to log without leaking content', () => {
  const result = classifySpokenTranscript('Hi!! 123');
  assert.equal(result.accepted, true);
  assert.equal(result.charCount, 5); // H, i, 1, 2, 3
});
