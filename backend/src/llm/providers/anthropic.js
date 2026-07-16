// Anthropic (Claude) provider — chat/reasoning quality for coaching & analysis.
// Claude has no embeddings API, so embeddings come from the embed provider.
const axios = require('axios');
const https = require('https');

// A briefing build makes several sequential/parallel calls to this same host;
// without a keep-alive agent, axios opens a fresh TCP+TLS connection per call
// (a real, avoidable ~0.3-1s of handshake latency each time). One shared agent
// reuses the socket across calls for the lifetime of the process.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });

// Thrown when the API declines to answer (HTTP 200, stop_reason: 'refusal').
// A distinct class so callers can retry/log this differently from a genuine
// network/HTTP failure instead of it falling through to empty/parsed-as-JSON
// content — see the stop_reason check below. Carries only safe metadata
// (never response content) so callers can log without a content leak.
class AnthropicRefusalError extends Error {
  constructor(category, meta = {}) {
    super(`Anthropic declined to respond${category ? ` (category: ${category})` : ''}`);
    this.name = 'AnthropicRefusalError';
    this.category = category || null;
    this.requestId = meta.requestId || null;
    this.model = meta.model || null;
  }
}

// Thrown when the response hit max_tokens before finishing — the caller must
// not hand a truncated body to a JSON parser and treat a parse failure (or,
// worse, a partial-but-valid-looking prefix) as a real result. `responseLength`
// is a count, never the truncated content itself.
class AnthropicMaxTokensError extends Error {
  constructor(meta = {}) {
    super('Anthropic response was truncated at max_tokens before completion');
    this.name = 'AnthropicMaxTokensError';
    this.requestId = meta.requestId || null;
    this.model = meta.model || null;
    this.maxTokens = meta.maxTokens ?? null;
    this.responseLength = meta.responseLength ?? null;
  }
}

async function generateText({
  system, prompt, maxTokens = 4096, timeoutMs = 110000, fast = false, model: modelOverride,
  jsonMode = false, jsonSchema = null, outputSchema = null, effort = null, returnMeta = false,
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  // `fast` routes clear commands (log a habit, swap a workout, set a reminder)
  // to a quicker model with NO extended thinking — those need an acknowledgment,
  // not reasoning. Real questions keep the default reasoning model + adaptive
  // thinking below, so nothing loses power. Override either with env vars.
  const model = modelOverride
    || (fast ? (process.env.ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5-20251001') : (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'));

  // Always safe to mark the system prompt as a cache breakpoint, whether or
  // not it happens to repeat verbatim: a prefix that changes call to call
  // (e.g. chat/review, which append a periodically-regenerated self-model
  // string) just misses the cache like it always did; anything below the
  // model's minimum cacheable prefix silently doesn't cache either — neither
  // case is an error or adds cost. It only pays off for callers whose prompt
  // is genuinely byte-identical across calls (e.g. briefing-ai.js's SYSTEM).
  const systemBlock = system
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : undefined;

  const body = {
    model,
    max_tokens: maxTokens,
    system: systemBlock,
    messages: [{ role: 'user', content: prompt }],
  };

  // jsonMode + a schema: force a single tool call whose input_schema IS the
  // shape we want, instead of hoping the model follows a prose instruction to
  // "return only valid JSON." This is the OLDER guarantee mechanism, kept for
  // existing callers that use it (e.g. the weekly-review call) — it remains
  // incompatible with extended thinking (the API rejects the combination), so
  // this path always omits `thinking`.
  //
  // outputSchema (native Structured Outputs, output_config.format) is the
  // NEWER, preferred guarantee mechanism for callers that also want extended
  // thinking: it constrains the ordinary text response to the schema
  // server-side — no forced tool_choice, no tool call, no prefill — so it
  // composes with `thinking` instead of conflicting with it. Pass a caller
  // via `outputSchema`/`effort` rather than `jsonMode`/`jsonSchema` to get
  // this path (see briefing-ai.js's chief-brief call).
  const useForcedTool = jsonMode && jsonSchema;
  if (useForcedTool) {
    body.tools = [{
      name: 'submit_result',
      description: 'Submit the result in the required structure.',
      input_schema: jsonSchema,
    }];
    body.tool_choice = { type: 'tool', name: 'submit_result' };
  } else {
    // Extended thinking only on the reasoning path; the fast command path
    // omits it entirely (biggest single latency saving for short
    // acknowledgments), and the forced-tool path above can't use it at all.
    if (!fast) body.thinking = { type: 'adaptive' };
    if (outputSchema || effort) {
      body.output_config = {};
      if (effort) body.output_config.effort = effort;
      if (outputSchema) body.output_config.format = { type: 'json_schema', schema: outputSchema };
    }
  }

  const { data } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    body,
    {
      timeout: timeoutMs,
      httpsAgent: keepAliveAgent,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );

  logUsage(model, data.usage);

  // The message ID (msg_...) doubles as a safe correlation ID for logging —
  // it identifies the specific API call without exposing anything about its
  // content, so callers can log it instead of a content preview.
  const requestId = data.id || null;
  const stopReason = data.stop_reason || null;

  // Guard BEFORE touching data.content — a refusal returns an empty (or, on
  // a mid-stream decline, partial) content array, and a max_tokens stop means
  // whatever text came back is truncated mid-object. Handing either straight
  // to a JSON parser produces a misleading "malformed JSON" failure that
  // hides the real cause; surface the real cause instead so callers can
  // retry/log it as what it actually is instead of a shape/parse bug. Both
  // errors carry only safe metadata (IDs, counts) — never response content.
  if (stopReason === 'refusal') {
    throw new AnthropicRefusalError(data.stop_details?.category, { requestId, model });
  }
  if (stopReason === 'max_tokens') {
    const truncatedLength = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('').length;
    throw new AnthropicMaxTokensError({ requestId, model, maxTokens, responseLength: truncatedLength });
  }

  let text;
  if (useForcedTool) {
    const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_result');
    // Re-stringify so every caller (via src/llm/parseJson.js) parses the
    // same way regardless of provider/mode — `input` here is already a JS
    // object, not text, since Anthropic parses the schema-constrained
    // generation for us.
    text = toolUse ? JSON.stringify(toolUse.input) : '';
  } else {
    // Thinking blocks have type 'thinking' — only join text blocks.
    text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
  }

  // Bare-string return is the default (every existing caller expects a
  // string). returnMeta is opt-in for callers that want safe-to-log metadata
  // alongside it (model, stop reason, request ID) without a breaking change
  // to the shared interface.
  return returnMeta ? { text, stopReason, requestId, model } : text;
}

// Visibility into cost/caching — previously `usage` was discarded entirely,
// so there was no way to tell if cache_control was doing anything or which
// calls dominate spend.
function logUsage(model, usage) {
  if (!usage) return;
  const { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } = usage;
  console.log(
    `[anthropic] ${model} in=${input_tokens ?? 0} out=${output_tokens ?? 0}` +
      ` cacheWrite=${cache_creation_input_tokens ?? 0} cacheRead=${cache_read_input_tokens ?? 0}`
  );
}

module.exports = { generateText, AnthropicRefusalError, AnthropicMaxTokensError };
