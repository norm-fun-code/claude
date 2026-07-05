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
  // Workout-substitution statements — regression test: this exact message
  // fell through to the full reasoning path (28s) because no existing
  // pattern covered "my workout was X instead of Y" phrasing.
  'My workout today instead of zone 2 was 30 minutes of biking and an hour of playing basketball. I wore my Apple Watch.',
  'instead of zone 2 I went for a hike',
  'my workout today was rough',
  // Level 3: weight + gratitude-text statements.
  'I weighed in at 172 today',
  'my weight is 172 today',
  "I'm grateful for my health and my family today",
  'grateful that the surgery went well',
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
  // "remind me" + a wh-word is RECALL ("remind me what X was"), not scheduling —
  // regression test for a real misclassification found in the day-1 audit.
  'remind me why I started this experiment',
  'remind me what my last HRV reading was',
  'remind me who I talked to about the lease',
  'can you remind me what my last experiment result was',
  // voice-transcript contractions missing their apostrophe must still read as
  // questions — regression test for the same audit.
  'hows my energy been lately',
  'whens my next experiment due',
  'wheres my spending trending',
  'whos been affecting my mood',
  // A workout question, not a substitution statement — must not be swept up
  // by the new "instead of zone2" pattern.
  'should I do something instead of zone 2 today?',
  'what should I do instead of zone 2 if I am sore?',
  // Weight/gratitude QUESTIONS must not be swept up by the new Level 3 patterns.
  "how's my weight trending this month?",
  'what am I most grateful for lately?',
];

test('commands are detected as commands', () => {
  for (const c of COMMANDS) assert.equal(looksLikeCommand(c), true, `should be a command: "${c}"`);
});

test('questions are NOT treated as commands', () => {
  for (const q of QUESTIONS) assert.equal(looksLikeCommand(q), false, `should be a question: "${q}"`);
});

test('"remind me to/at" scheduling requests are still commands', () => {
  assert.equal(looksLikeCommand('remind me to call mom at 6'), true);
  assert.equal(looksLikeCommand('remind me to stretch in 2 minutes'), true);
});

test('empty / whitespace is not a command', () => {
  assert.equal(looksLikeCommand(''), false);
  assert.equal(looksLikeCommand('   '), false);
});
