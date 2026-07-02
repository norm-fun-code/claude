const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAction } = require('../src/chat/ask');

test('parses a valid workout swap and maps to the executor shape', () => {
  const a = parseAction('Done — swapped it.\n\n<action>{"type":"swap_workout","workoutId":"zone2"}</action>');
  assert.deepEqual(a, { action: 'swap_workout', workoutId: 'zone2' });
});

test('rejects an out-of-enum workout id (no side effect from a hallucinated value)', () => {
  assert.equal(parseAction('<action>{"type":"swap_workout","workoutId":"crossfit"}</action>'), null);
});

test('parses a habit log', () => {
  assert.deepEqual(
    parseAction('Logged it.<action>{"type":"log_habit","habit":"coldShower"}</action>'),
    { action: 'log_habit', habit: 'coldShower' }
  );
});

test('parses add_context and truncates overly long text', () => {
  const long = 'x'.repeat(500);
  const a = parseAction(`<action>{"type":"add_context","text":"${long}"}</action>`);
  assert.equal(a.action, 'add_context');
  assert.equal(a.text.length, 200);
});

test('parses add_chapter, defaulting an unknown kind to note', () => {
  const a = parseAction('<action>{"type":"add_chapter","kind":"wedding","label":"Anniversary","keyDate":"2027-05-01","keyDateLabel":"on"}</action>');
  assert.equal(a.action, 'add_chapter');
  assert.equal(a.kind, 'note');
  assert.equal(a.label, 'Anniversary');
  assert.equal(a.keyDate, '2027-05-01');
});

test('no tag → null', () => {
  assert.equal(parseAction('Just a normal advice answer with no action.'), null);
});

test('unknown action type → null', () => {
  assert.equal(parseAction('<action>{"type":"delete_everything"}</action>'), null);
});

test('malformed JSON in the tag → null (never throws)', () => {
  assert.equal(parseAction('<action>{not json}</action>'), null);
});

test('empty required fields → null (no empty context/chapter written)', () => {
  assert.equal(parseAction('<action>{"type":"add_context","text":"   "}</action>'), null);
  assert.equal(parseAction('<action>{"type":"add_chapter","label":""}</action>'), null);
});
