// Bug: a daily brief narrated a single alcohol log after two clean nights as
// "third straight day" and "550% above usual". Part of the fix is a prompt
// contract in briefing-ai.js's CHIEF_SYSTEM: PERSISTENT ISSUES' "open N days"
// describes finding persistence, not consecutive user behavior, and must
// never be translated into "N straight/consecutive days"; a nightly context
// tag's recency must be cited from RECENT CONTEXT TAGS' exact phrasing, never
// invented as a percentage or a different streak length.
const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/llm');
const { generateChiefBrief, buildChiefBriefPrompt } = require('../src/services/briefing-ai');

function captureChiefSystem(t) {
  let capturedSystem = null;
  const original = llm.generateText;
  t.after(() => { llm.generateText = original; });
  llm.generateText = async ({ system }) => {
    capturedSystem = system;
    return JSON.stringify({
      chiefBrief: { synthesis: 's', action: 'a', risk: 'r', move: 'm', openQuestion: '' },
      morningFocus: 'f',
      urgentEmails: [],
    });
  };
  return () => capturedSystem;
}

test('CHIEF_SYSTEM forbids translating finding-age ("open N days") into consecutive-day behavior claims', async (t) => {
  const getSystem = captureChiefSystem(t);
  await generateChiefBrief([], 'Sunday', { type: 'Rest' }, []);
  const system = getSystem();
  assert.ok(system, 'expected the chief-brief LLM call to have fired');
  assert.match(system, /open N days.*describes how long a FINDING has been flagged/i);
  assert.match(system, /never translate finding-age into/i);
});

test('CHIEF_SYSTEM requires RECENT CONTEXT TAGS\' exact phrasing for context tags, forbidding invented percentages', async (t) => {
  const getSystem = captureChiefSystem(t);
  await generateChiefBrief([], 'Sunday', { type: 'Rest' }, []);
  const system = getSystem();
  assert.match(system, /RECENT CONTEXT TAGS/);
  assert.match(system, /never compute or invent a.*percentage-above-baseline/i);
});

// buildChiefBriefPrompt's continuityContext param is the exact string
// routes/briefing.js assembles (PERSISTENT ISSUES + RECENT CONTEXT TAGS,
// etc.) — verify it reaches the actual prompt sent to the model verbatim,
// not just that CHIEF_SYSTEM mentions the concept.
test('a RECENT CONTEXT TAGS block passed as continuityContext reaches the composed prompt verbatim', () => {
  const continuityContext = 'RECENT CONTEXT TAGS (factual — cite these exact counts; NEVER convert them into a percentage-above-baseline or a different streak length):\n- Alcohol: logged on 1 of the last 3 days';
  const { prompt } = { prompt: buildChiefBriefPrompt([], 'Sunday', { type: 'Rest' }, [], '', '', '', '', '', '', [], '', '', continuityContext) };
  assert.ok(prompt.includes(continuityContext), 'the exact computed recency block must reach the prompt unmodified');
});
