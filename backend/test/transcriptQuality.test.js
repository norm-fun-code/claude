// Push-to-talk's transcript-quality guard — mirrors mobile's
// transcriptGuard.ts so both live-conversation surfaces reject the same
// class of silence/phantom-language noise. Required scenarios: silence and
// background noise produce no transcript, and a weak phantom
// foreign-language transcript is discarded (English session).
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyTranscript } = require('../src/chat/transcriptQuality');

test('required: empty/silence transcript is rejected', () => {
  assert.equal(classifyTranscript('').accepted, false);
  assert.equal(classifyTranscript('   ').accepted, false);
});

test('required: a phantom foreign-language transcript from noise is discarded on an English session', () => {
  const r = classifyTranscript('お願いします。', { language: 'en' });
  assert.equal(r.accepted, false);
  assert.match(r.reason, /unexpected_script/);
});

test('the SAME transcript is accepted when the session is actually configured for that language', () => {
  const r = classifyTranscript('お願いします。', { language: 'ja' });
  assert.equal(r.accepted, true);
});

test('a punctuation-only transcript is rejected', () => {
  assert.equal(classifyTranscript('...!?', { language: 'en' }).accepted, false);
});

test('a normal English utterance is accepted', () => {
  assert.equal(classifyTranscript('What should I do today?', { language: 'en' }).accepted, true);
});

test('a very short, weak-evidence fragment on an English session is rejected', () => {
  const r = classifyTranscript('が', { language: 'en' });
  assert.equal(r.accepted, false);
});
