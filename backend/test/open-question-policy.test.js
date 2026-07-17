// Pure unit coverage for intelligence/open-question-policy.js — the shared
// suppression logic every chief-brief generation path (full build, scoped
// rebuild, carried-forward fallback) routes through. See
// test/integration/open-question-suppression.test.js for the route-level
// end-to-end coverage against a real DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isSameOpenQuestionTopic, stripAnsweredOpenQuestion, openQuestionFingerprint, openQuestionTopicKey,
  formatAnsweredQuestionsContext,
} = require('../src/intelligence/open-question-policy');

test('isSameOpenQuestionTopic: exact repeat is the same topic', () => {
  assert.equal(isSameOpenQuestionTopic('Are you scaling back the launch?', 'Are you scaling back the launch?'), true);
});

test('isSameOpenQuestionTopic: a close paraphrase is the same topic', () => {
  assert.equal(isSameOpenQuestionTopic(
    'Are you scaling back the Q3 launch or pushing through?',
    'Are you scaling back the Q3 launch, or pushing through it?'
  ), true);
});

test('isSameOpenQuestionTopic: a genuinely different question is NOT the same topic', () => {
  assert.equal(isSameOpenQuestionTopic('Are you scaling back the launch?', 'Did you sleep OK last night?'), false);
});

test('isSameOpenQuestionTopic: two short questions sharing only incidental words are NOT the same topic', () => {
  assert.equal(isSameOpenQuestionTopic('Called today a rest day — still right?', 'Is today the day you fly out?'), false);
});

test('stripAnsweredOpenQuestion: blanks openQuestion when a matching answer exists today', () => {
  const brief = { openQuestion: 'Are you scaling back the launch?', synthesis: 'x' };
  const out = stripAnsweredOpenQuestion(brief, [{ questionText: 'Are you scaling back the launch or pushing through?' }]);
  assert.equal(out.openQuestion, '');
  assert.equal(out.openQuestionFingerprint, null);
});

test('stripAnsweredOpenQuestion: leaves a genuinely different openQuestion untouched (but stamps a fingerprint)', () => {
  const brief = { openQuestion: 'Did you sleep OK?', synthesis: 'x' };
  const out = stripAnsweredOpenQuestion(brief, [{ questionText: 'Are you scaling back the launch?' }]);
  assert.equal(out.openQuestion, 'Did you sleep OK?');
  assert.equal(out.openQuestionFingerprint, openQuestionFingerprint('Did you sleep OK?'));
});

test('stripAnsweredOpenQuestion: a chiefBrief with no openQuestion is returned unchanged (same reference)', () => {
  const brief = { openQuestion: '', synthesis: 'x' };
  assert.equal(stripAnsweredOpenQuestion(brief, [{ questionText: 'anything' }]), brief);
});

test('stripAnsweredOpenQuestion: null chiefBrief is a no-op', () => {
  assert.equal(stripAnsweredOpenQuestion(null, []), null);
});

test('stripAnsweredOpenQuestion: empty answered list leaves the question untouched and still stamps a fingerprint', () => {
  const brief = { openQuestion: 'Are you scaling back the launch?', synthesis: 'x' };
  const out = stripAnsweredOpenQuestion(brief, []);
  assert.equal(out.openQuestion, 'Are you scaling back the launch?');
  assert.ok(out.openQuestionFingerprint);
});

test('openQuestionFingerprint: normalizes case/whitespace so equivalent text produces the same value', () => {
  assert.equal(openQuestionFingerprint('  Are you  scaling BACK the launch?  '), openQuestionFingerprint('are you scaling back the launch?'));
});

test('openQuestionFingerprint: empty/whitespace text yields null', () => {
  assert.equal(openQuestionFingerprint(''), null);
  assert.equal(openQuestionFingerprint('   '), null);
});

test('openQuestionTopicKey: word order does not change the key', () => {
  assert.equal(openQuestionTopicKey('scaling back the launch'), openQuestionTopicKey('the launch scaling back'));
});

test('formatAnsweredQuestionsContext: formats question/answer pairs, skipping incomplete rows', () => {
  const text = formatAnsweredQuestionsContext([
    { questionText: 'Are you scaling back the launch?', answer: 'pushing through' },
    { questionText: 'missing answer' }, // no answer -> skipped
    { answer: 'missing question' }, // no questionText -> skipped
  ]);
  assert.equal(text, '- Asked: "Are you scaling back the launch?" -> Answered: "pushing through"');
});

test('formatAnsweredQuestionsContext: empty/absent input yields an empty string', () => {
  assert.equal(formatAnsweredQuestionsContext([]), '');
  assert.equal(formatAnsweredQuestionsContext(undefined), '');
});
