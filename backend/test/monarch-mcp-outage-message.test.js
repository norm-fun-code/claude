// Live-reproduced bug: when Monarch's MCP is paused on THEIR end, every tool
// call still returns HTTP 200 with a normal-shaped MCP text content block —
// but the text is a plain-English outage notice instead of JSON. The actual
// production response, captured via GET /api/debug/wealth-budget?raw=1:
//   "The Monarch MCP is temporarily paused while we work through a data
//    portability question raised by one of our partners..."
// JSON.parse on that fails, and extractJsonContent used to silently fall back
// to returning the raw string — every caller's `r?.data || []`-style access on
// a string defaults to empty, so this looked like a genuinely empty (but
// successful) response instead of a total outage. Fixed by detecting this
// specific class of response and throwing instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractJsonContent } = require('../src/services/monarch-mcp-rpc');

const REAL_OUTAGE_MESSAGE =
  "The Monarch MCP is temporarily paused while we work through a data portability question raised by one of our partners. " +
  "We're working to restore access as soon as possible. Please visit https://help.monarch.com/hc/en-us/articles/50207234679956-Monarch-MCP-Connector for more information.";

test('extractJsonContent throws on the real captured Monarch MCP outage message', () => {
  const result = { content: [{ type: 'text', text: REAL_OUTAGE_MESSAGE }] };
  assert.throws(() => extractJsonContent(result), /Monarch MCP is unavailable/);
});

test('extractJsonContent still returns valid JSON normally', () => {
  const result = { content: [{ type: 'text', text: JSON.stringify({ data: [{ category: 'Groceries', budget_amount: -400 }] }) }] };
  const parsed = extractJsonContent(result);
  assert.deepEqual(parsed, { data: [{ category: 'Groceries', budget_amount: -400 }] });
});

test('extractJsonContent still returns other non-JSON text as-is (not every parse failure is an outage)', () => {
  const result = { content: [{ type: 'text', text: 'some unrelated plain-text tool response' }] };
  assert.equal(extractJsonContent(result), 'some unrelated plain-text tool response');
});

test('extractJsonContent returns null when there is no text content block', () => {
  assert.equal(extractJsonContent({ content: [] }), null);
  assert.equal(extractJsonContent(null), null);
});
