// The Realtime voice tool layer's allowlist/dispatch contract — pure, no DB.
// Every tool schema OpenAI receives must be well-formed, the handler registry
// must exactly match the advertised schema names (no tool the model can see
// but can't call, and no callable name the model was never told about), and
// an unknown name must fail loudly rather than silently no-op — a session
// can never reach an arbitrary backend function through this dispatcher.
const test = require('node:test');
const assert = require('node:assert/strict');
const { TOOL_SCHEMAS, TOOL_NAMES, runTool } = require('../src/chat/realtimeTools');

test('every tool schema is well-formed (type, name, description, parameters)', () => {
  assert.ok(TOOL_SCHEMAS.length >= 9, 'expected at least the 9 documented tools');
  for (const t of TOOL_SCHEMAS) {
    assert.equal(t.type, 'function');
    assert.ok(t.name && typeof t.name === 'string');
    assert.ok(t.description && t.description.length > 10, `${t.name} needs a real description`);
    assert.equal(t.parameters?.type, 'object');
    assert.equal(t.parameters?.additionalProperties, false, `${t.name} must reject unlisted parameters`);
  }
});

test('the schema names and the runnable handler names match exactly', () => {
  const schemaNames = new Set(TOOL_SCHEMAS.map((t) => t.name));
  assert.equal(schemaNames.size, TOOL_NAMES.size, 'no duplicate schema names');
  for (const n of schemaNames) assert.ok(TOOL_NAMES.has(n), `${n} is advertised but not runnable`);
  for (const n of TOOL_NAMES) assert.ok(schemaNames.has(n), `${n} is runnable but never advertised to the model`);
});

test('runTool rejects an unknown name instead of silently doing nothing', async () => {
  await assert.rejects(() => runTool('delete_everything', {}), /unknown tool/);
});

test('the required tool set matches the product spec (narrowly scoped, cohesive)', () => {
  const names = [...TOOL_NAMES];
  for (const expected of [
    'get_today_context', 'get_current_recovery', 'get_active_goals_and_commitments',
    'get_recent_findings', 'search_beliefs', 'query_metric', 'search_personal_library',
    'execute_normos_action', 'deep_ask',
  ]) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
});

test('execute_normos_action rejects a malformed action without throwing', async () => {
  const result = await runTool('execute_normos_action', { type: 'delete_all_data' });
  assert.equal(result.done, false);
});

test('execute_normos_action rejects an action with an invalid enum value', async () => {
  const result = await runTool('execute_normos_action', { type: 'swap_workout', workoutId: 'marathon' });
  assert.equal(result.done, false);
});

test('query_metric requires domain and metric', async () => {
  const result = await runTool('query_metric', {});
  assert.ok(result.error);
});
