const test = require('node:test');
const assert = require('node:assert/strict');
const { looksLikeCommand } = require('../src/chat/ask');

// Commands take the fast acknowledgment path.
const COMMANDS = [
  'log my cold shower',
  'swap my workout to a walk',
  'switch today to a rest day',
  'remind me to stretch in 2 minutes',
  'remind me to call mom at 6',
  'my mood energy and focus were all 5 today',
  'my energy is a 3 today',
  "today's context: had a rough day, poor sleep and a stressful launch",
  'remember my sister visits next Friday',
  'note that I traveled today',
  'I did my gratitude journal',
  'I already finished my workout',
];

// Questions must fall through to the full reasoning path (power preserved).
const QUESTIONS = [
  'should I swap my workout today?',
  'why has my HRV been sliding this week?',
  'how did my sleep affect my focus?',
  'what should I prioritize this quarter?',
  'can you compare my spending to last month?',
  "what's driving my energy dip?",
  'tell me how my experiment is going',
  'is my recovery good enough to train hard?',
  // has a command-ish clause but is ultimately a question (ends in ?)
  'I did my cold shower — how did my HRV look?',
];

test('commands are detected as commands', () => {
  for (const c of COMMANDS) assert.equal(looksLikeCommand(c), true, `should be a command: "${c}"`);
});

test('questions are NOT treated as commands', () => {
  for (const q of QUESTIONS) assert.equal(looksLikeCommand(q), false, `should be a question: "${q}"`);
});

test('empty / whitespace is not a command', () => {
  assert.equal(looksLikeCommand(''), false);
  assert.equal(looksLikeCommand('   '), false);
});
