// The briefing LLM call was split from one combined generateBriefing() call into
// two independent calls (generateChiefBrief + generateWisdomInsights) so they can
// run in parallel and so a same-day rebuild can skip the wisdom call entirely
// (its output is discarded by server.js's day-lock anyway — see briefing-ai.js's
// file header). These tests stub the shared llm module and verify: each function
// parses/validates its own JSON shape correctly, and the combined generateBriefing
// wrapper still merges both into the same shape the old single call returned.
const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/llm');

// Field text is deliberately long enough to clear assessChiefBriefQuality's
// minimum-completeness bar (brain/claimValidator.js) — a too-short "valid"
// fixture would otherwise silently trigger the one bounded quality retry and
// throw off every exact-call-count assertion in this file.
const CHIEF_JSON = JSON.stringify({
  chiefBrief: {
    synthesis: 'Test synthesis with enough words in it to clear the quality bar for a complete brief.',
    action: 'Test action with enough words here to clear the bar.',
    risk: 'Test risk with enough words here to clear the bar.',
    move: 'Test move with enough words here to clear the bar.',
    openQuestion: '',
  },
  morningFocus: 'Test morning focus with enough words in it to comfortably clear the fifteen word minimum threshold for this field.',
  urgentEmails: [],
});
const WISDOM_JSON = JSON.stringify({
  quoteInsight: 'Test quote insight.',
  notionQuote: 'A complete, self-contained sentence of real wisdom worth reading.',
  notionInsight: 'Test notion insight.',
});

// The chief-brief call requests returnMeta:true (it needs safe-to-log
// metadata alongside the text — see briefing-ai.js), so it gets
// {text, stopReason, requestId, model} back, not a bare string. The wisdom
// call doesn't request returnMeta and still expects a bare string.
function chiefMeta(text) {
  return { text, stopReason: 'end_turn', requestId: 'test-req', model: 'claude-opus-4-8' };
}

function stubLlm(responses) {
  // responses: array of strings returned in call order (chief first in generateBriefing's
  // Promise.all ordering doesn't matter since we key off the SYSTEM prompt instead).
  llm.generateText = async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) return chiefMeta(responses.chief);
    if (system.includes('reflective "wisdom" section')) return responses.wisdom;
    throw new Error('unexpected system prompt in stub');
  };
}

const { generateBriefing, generateChiefBrief, generateWisdomInsights } = require('../src/services/briefing-ai');

test('generateChiefBrief parses a valid response into the expected shape', async () => {
  stubLlm({ chief: CHIEF_JSON, wisdom: WISDOM_JSON });
  const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  assert.equal(result.morningFocus, 'Test morning focus with enough words in it to comfortably clear the fifteen word minimum threshold for this field.');
  assert.ok(result.chiefBrief);
  assert.equal(result.chiefBrief.synthesis, 'Test synthesis with enough words in it to clear the quality bar for a complete brief.');
  assert.deepEqual(result.urgentEmails, []);
});

test('generateWisdomInsights parses a valid response and keeps a legitimate notionQuote', async () => {
  stubLlm({ chief: CHIEF_JSON, wisdom: WISDOM_JSON });
  const result = await generateWisdomInsights('some notion text', 'a quote', 'mood ok');
  assert.equal(result.quoteInsight, 'Test quote insight.');
  assert.equal(result.notionQuote, 'A complete, self-contained sentence of real wisdom worth reading.');
  assert.equal(result.notionInsight, 'Test notion insight.');
});

test('generateWisdomInsights rejects a heading-like notionQuote', async () => {
  stubLlm({
    chief: CHIEF_JSON,
    wisdom: JSON.stringify({ quoteInsight: 'x', notionQuote: '[section: Money]', notionInsight: 'should be dropped too' }),
  });
  const result = await generateWisdomInsights('notion text', 'quote', '');
  assert.equal(result.notionQuote, '');
  assert.equal(result.notionInsight, '', 'insight is dropped along with a rejected quote');
});

// Item #8 from the deep product critique: the mobile app's AFFIRMATIONS
// block was 3 hardcoded generic lines ("I show up with joy, presence, and
// courage!"), unrelated to any real data — the one part of the brief that
// wasn't evidenced. Replaced with an LLM-generated, data-grounded field.
test('generateChiefBrief passes through a data-grounded affirmation', async () => {
  stubLlm({
    chief: JSON.stringify({
      chiefBrief: {
        synthesis: 'Test synthesis.', action: 'Test action.', risk: 'Test risk.', move: 'Test move.', openQuestion: '',
        affirmation: "I've shown up for cold showers 12 days straight.",
      },
      morningFocus: 'Test morning focus.',
      urgentEmails: [],
    }),
    wisdom: WISDOM_JSON,
  });
  const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  assert.equal(result.chiefBrief.affirmation, "I've shown up for cold showers 12 days straight.");
});

test('generateChiefBrief defaults affirmation to empty string when the LLM omits it (backward-compatible, not fatal)', async () => {
  stubLlm({ chief: CHIEF_JSON, wisdom: WISDOM_JSON }); // CHIEF_JSON has no affirmation field
  const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  assert.equal(result.chiefBrief.affirmation, '');
  assert.ok(result.chiefBrief, 'a missing affirmation must not null out the whole chiefBrief (unlike synthesis/action/risk/move)');
});

test('generateChiefBrief returns null chiefBrief when a required field is missing', async () => {
  stubLlm({
    chief: JSON.stringify({ chiefBrief: { synthesis: 'x', action: 'y', risk: 'z' /* move missing */ }, morningFocus: 'f' }),
    wisdom: WISDOM_JSON,
  });
  const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  assert.equal(result.chiefBrief, null);
});

test('generateChiefBrief retries once and recovers if the second attempt is valid', async () => {
  let call = 0;
  llm.generateText = async ({ system }) => {
    if (!system.includes('chief of staff and data scientist')) return WISDOM_JSON;
    call++;
    // First call: invalid (missing "move"). Second call (the retry): valid.
    return chiefMeta(call === 1
      ? JSON.stringify({ chiefBrief: { synthesis: 'x', action: 'y', risk: 'z' }, morningFocus: 'f' })
      : CHIEF_JSON);
  };
  const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  assert.equal(call, 2, 'expected exactly one retry');
  assert.ok(result.chiefBrief, 'the retry succeeded, so chiefBrief should be populated, not null');
  assert.equal(result.chiefBrief.synthesis, 'Test synthesis with enough words in it to clear the quality bar for a complete brief.');
});

test('generateChiefBrief gives up (null) only after BOTH attempts fail', async () => {
  let call = 0;
  llm.generateText = async ({ system }) => {
    if (!system.includes('chief of staff and data scientist')) return WISDOM_JSON;
    call++;
    return chiefMeta('not json at all, both times');
  };
  const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  assert.equal(call, 2, 'expected the retry to have been attempted before giving up');
  assert.equal(result.chiefBrief, null);
});

// The caller (briefing.js) silently falls back to the PRIOR build's chiefBrief
// whenever this comes back null — so an invalid shape here used to be
// completely untraceable in production (the exact bug this test guards
// against: a rebuild that silently keeps showing yesterday's brief). This
// must log which field(s) were missing so a recurrence is diagnosable.
test('generateChiefBrief logs which field was invalid so a silent stale-brief fallback is diagnosable', async () => {
  stubLlm({
    chief: JSON.stringify({ chiefBrief: { synthesis: 'x', action: 'y', risk: 'z' /* move missing */ }, morningFocus: 'f' }),
    wisdom: WISDOM_JSON,
  });
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  try {
    await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  } finally {
    console.error = originalError;
  }
  assert.ok(
    logs.some((l) => l.includes('shape invalid') && l.includes('move')),
    `expected a log naming the missing field "move"; got: ${JSON.stringify(logs)}`
  );
});

test('generateChiefBrief falls back to empty shape on malformed JSON', async () => {
  llm.generateText = async () => chiefMeta('not json at all');
  const result = await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  assert.equal(result.morningFocus, '');
  assert.equal(result.chiefBrief, null);
  assert.deepEqual(result.urgentEmails, []);
  assert.equal(result.chiefBriefQuality.status, 'failed');
  assert.deepEqual(result.chiefBriefQuality.reasonCodes, ['generation_failed']);
  assert.deepEqual(result.chiefBriefQuality.fieldWordCounts, {});
  assert.deepEqual(result.chiefBriefQuality.fallbackFields, []);
  assert.deepEqual(result.chiefBriefQuality.violatedChecks, []);
  // Safe diagnostic metadata (item D) — never generated prose, but enough to
  // trace WHICH attempt/correlation produced a failed result.
  assert.equal(result.chiefBriefQuality.failedAttempt, 'generation_failed');
  assert.ok(result.chiefBriefQuality.correlationId);
});

test('generateBriefing (combined, backward-compat) merges both calls into one object', async () => {
  stubLlm({ chief: CHIEF_JSON, wisdom: WISDOM_JSON });
  const result = await generateBriefing([], 'notion text', 'a quote', 'Tuesday', { type: 'Rest' }, []);
  assert.equal(result.morningFocus, 'Test morning focus with enough words in it to comfortably clear the fifteen word minimum threshold for this field.');
  assert.ok(result.chiefBrief);
  assert.equal(result.quoteInsight, 'Test quote insight.');
  assert.equal(result.notionQuote, 'A complete, self-contained sentence of real wisdom worth reading.');
});

// Live bug found via a product screenshot review: the Brief read "today's
// calendar is heavy — 8.5 hours blocked including your Sabbath window from
// 5 PM on." Blocking personal/observance time is protecting it, the
// opposite of a demanding calendar — but the system prompt only ever told
// the model to gauge load from the WORK calendar, never explicitly telling
// it NOT to fold personal-calendar blocks into that load figure, so the
// model drifted into summing them anyway. These assert the explicit
// exclusion is present in the live system prompt.
test('CHIEF_SYSTEM tells the model never to count a personal-calendar block (e.g. a Sabbath window) as calendar load', async () => {
  let capturedSystem = null;
  llm.generateText = async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) { capturedSystem = system; return chiefMeta(CHIEF_JSON); }
    return WISDOM_JSON;
  };
  await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  assert.ok(capturedSystem);
  assert.match(capturedSystem, /NEVER count a personal-calendar event.*toward.*heavy/i);
  assert.match(capturedSystem, /Sabbath/);
  assert.match(capturedSystem, /protecting it, the opposite of a demanding calendar|is the user protecting time, never a source of load/i);
});

// Live bug: a noisy percentage-of-a-small-base spike (e.g. 400% off a $100
// average) was stated with the same flat confidence as a durable multi-week
// trend, manufacturing false urgency. The system prompt now instructs the
// model to hedge language on noisy/small-sample signals and state plainly
// only on durable ones.
test('CHIEF_SYSTEM instructs confidence calibration — hedge noisy small-base signals, state durable trends plainly', async () => {
  let capturedSystem = null;
  llm.generateText = async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) { capturedSystem = system; return chiefMeta(CHIEF_JSON); }
    return WISDOM_JSON;
  };
  await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  assert.ok(capturedSystem);
  assert.match(capturedSystem, /CONFIDENCE CALIBRATION/);
  assert.match(capturedSystem, /hedge it/i);
});

// "Relay, don't restate": a life-chapter fact (e.g. a pregnancy) is threaded
// through multiple surfaces (the brief, goals, forecasts, Ask) by design —
// the critique's fix wasn't fewer mentions, it's that each mention should
// advance the thread instead of repeating the bare fact. Confirms the
// CHIEF_SYSTEM prompt carries that instruction for the LIFE CHAPTERS block.
test('CHIEF_SYSTEM instructs relaying life-chapter facts forward, not restating them', async () => {
  let capturedSystem = null;
  llm.generateText = async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) { capturedSystem = system; return chiefMeta(CHIEF_JSON); }
    return WISDOM_JSON;
  };
  await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  assert.ok(capturedSystem);
  assert.match(capturedSystem, /RELAY, DON'T RESTATE/);
});

// Live bug found via a product review: the Affirmation said "I closed out
// all three goals I set for myself this week, including finishing the
// valuation work I was worried about" — the goal-completion is real, but
// "which I was worried about" was fabricated; no data source stated the
// user felt worried about it. Confirms CHIEF_SYSTEM explicitly forbids
// decorating a real, grounded fact with an invented feeling/motive.
test('CHIEF_SYSTEM forbids embellishing the affirmation with an invented feeling not present in the data', async () => {
  let capturedSystem = null;
  llm.generateText = async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) { capturedSystem = system; return chiefMeta(CHIEF_JSON); }
    return WISDOM_JSON;
  };
  await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  assert.ok(capturedSystem);
  assert.match(capturedSystem, /do not embellish a real fact with an invented feeling/);
  assert.match(capturedSystem, /which I was worried about/);
});

// Live bug found via a product review: THE ACTION said "you mentioned
// sleeping hot and twisting last night" — traced to zero real data source.
// The only genuine "last night" text anywhere in the pipeline is
// recovery.js's proxy caveat ("self-reported sleep ... no Eight Sleep
// reading last night"), which says nothing about heat or restlessness. The
// model invented sensory detail to color in a vague fact — the same
// fabrication class as the affirmation bug, but general to any field, not
// just affirmation. Also covers a related case from the same review: a
// goal's own stated text ("investor update kickoff") got silently shortened
// to "investor kickoff" in the synthesis — quoting a named thing inexactly
// is the same failure mode as inventing a feeling.
test('CHIEF_SYSTEM forbids inventing sensory/emotional detail or altering a named thing\'s exact wording, globally (not just in affirmation)', async () => {
  let capturedSystem = null;
  llm.generateText = async ({ system }) => {
    if (system.includes('chief of staff and data scientist')) { capturedSystem = system; return chiefMeta(CHIEF_JSON); }
    return WISDOM_JSON;
  };
  await generateChiefBrief([], 'Tuesday', { type: 'Rest' }, []);
  assert.ok(capturedSystem);
  assert.match(capturedSystem, /never invent a sensory or emotional detail/);
  assert.match(capturedSystem, /slept hot.*tossing and turning/);
  assert.match(capturedSystem, /do not shorten, rename, or paraphrase it/);
  assert.match(capturedSystem, /investor update kickoff/);
});

// Live bug: Wisdom said "mood, energy, and focus all sitting steady this
// week" while the SAME day's Chief Brief said "focus is down 26% and mood
// down 29% — five days running." Both draw from real data, but Wisdom only
// ever received wellbeingContext — a coarse 7-day AVERAGE level (low/ok/high)
// that can read "ok" even mid-decline, since an average absorbs a drop that
// happened partway through the week. The Chief Brief gets the accurate
// picture from continuityContext (the "PERSISTENT ISSUES" ledger — see
// routes/briefing.js's streaks/continuityContext, sourced from
// analyze.js's computeTrends), which Wisdom never received at all. Confirms
// generateWisdomInsights now threads continuityContext into the prompt, and
// the system prompt tells the model to treat it as authoritative over the
// coarse average.
test('generateWisdomInsights receives continuityContext and the prompt instructs it to defer to real trend/duration data over the coarse wellbeing average', async () => {
  let capturedPrompt = null;
  llm.generateText = async ({ system, prompt }) => {
    if (system.includes('reflective "wisdom" section')) { capturedPrompt = prompt; return WISDOM_JSON; }
    return chiefMeta(CHIEF_JSON);
  };
  await generateWisdomInsights(
    'some notion text',
    'a quote',
    'mood ok; energy ok; focus ok',
    '- Focus down 26% vs your 7d norm (worsening) — open 5 days running\n- Mood down 29% vs your 7d norm (worsening) — open 5 days running'
  );
  assert.ok(capturedPrompt);
  assert.match(capturedPrompt, /Focus down 26%/, 'the persistent-findings block must actually reach the prompt');
  assert.match(capturedPrompt, /open 5 days running/);
});

test('generateWisdomInsights omits the findings block entirely when continuityContext is empty (never a stray empty section)', async () => {
  let capturedPrompt = null;
  llm.generateText = async ({ system, prompt }) => {
    if (system.includes('reflective "wisdom" section')) { capturedPrompt = prompt; return WISDOM_JSON; }
    return chiefMeta(CHIEF_JSON);
  };
  await generateWisdomInsights('some notion text', 'a quote', 'mood ok');
  assert.ok(capturedPrompt);
  assert.doesNotMatch(capturedPrompt, /Ongoing findings/);
});

test('WISDOM_SYSTEM tells the model the wellbeing average can look "steady" mid-decline, and to defer to Ongoing findings instead', async () => {
  let capturedSystem = null;
  llm.generateText = async ({ system }) => {
    if (system.includes('reflective "wisdom" section')) { capturedSystem = system; return WISDOM_JSON; }
    return chiefMeta(CHIEF_JSON);
  };
  await generateWisdomInsights('notion text', 'quote', 'mood ok');
  assert.ok(capturedSystem);
  assert.match(capturedSystem, /coarse 7-day AVERAGE level/);
  assert.match(capturedSystem, /Never call mood\/energy\/focus "steady,"/);
  assert.match(capturedSystem, /Ongoing findings/);
});

test('generateBriefing runs chief and wisdom calls concurrently, not serially', async () => {
  const order = [];
  llm.generateText = async ({ system }) => {
    const label = system.includes('chief of staff and data scientist') ? 'chief' : 'wisdom';
    order.push(`${label}:start`);
    await new Promise((r) => setTimeout(r, 20));
    order.push(`${label}:end`);
    return label === 'chief' ? chiefMeta(CHIEF_JSON) : WISDOM_JSON;
  };
  await generateBriefing([], 'notion text', 'a quote', 'Tuesday', { type: 'Rest' }, []);
  // Both starts happen before either end — proof they overlapped rather than
  // running one to completion before the other began.
  const firstEndIdx = order.findIndex((e) => e.endsWith(':end'));
  const startsBeforeFirstEnd = order.slice(0, firstEndIdx).filter((e) => e.endsWith(':start')).length;
  assert.equal(startsBeforeFirstEnd, 2, 'both calls should have started before either finished');
});
