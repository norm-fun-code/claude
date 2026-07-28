// Regression tests for the pure spoken-turn accept/reject/idempotency
// decision that backs realtimeVoice.ts's pre-response audio-turn gate. Run
// via: node --experimental-strip-types --test src/lib/realtimeTurnGate.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { isStaleTurn } from './realtimeTurnGate.ts';
import { decideSpokenTurn } from './realtimeTurnGate.ts';

test('rejects the exact お願いします。 reproduction, with a delete target and a content-free log line', () => {
  const decision = decideSpokenTurn('item-1', 'お願いします。', new Set());
  assert.equal(decision.kind, 'rejected');
  if (decision.kind !== 'rejected') return;
  assert.equal(decision.deleteItemId, 'item-1');
  assert.equal(decision.result.reason, 'unexpected_script');
  assert.ok(!decision.logLine.includes('お願いします'), 'the log line must never contain the transcript');
  assert.match(decision.logLine, /reason=unexpected_script/);
});

test('rejects other non-Latin phantom transcripts', () => {
  for (const text of ['Спасибо', '谢谢你', '감사합니다', 'شكرا']) {
    const decision = decideSpokenTurn('item-x', text, new Set());
    assert.equal(decision.kind, 'rejected', `"${text}" must be rejected`);
  }
});

test('rejects empty and punctuation-only transcripts', () => {
  for (const text of ['', '   ', '...', '?!']) {
    const decision = decideSpokenTurn('item-x', text, new Set());
    assert.equal(decision.kind, 'rejected', `"${JSON.stringify(text)}" must be rejected`);
  }
});

test('accepts a normal English paragraph', () => {
  const decision = decideSpokenTurn('item-p', "What's on my calendar this afternoon?", new Set());
  assert.equal(decision.kind, 'accepted');
  if (decision.kind === 'accepted') assert.equal(decision.transcript, "What's on my calendar this afternoon?");
});

test('preserves "Yes", "No", "Stop", "Hey"', () => {
  for (const word of ['Yes', 'No', 'Stop', 'Hey']) {
    const decision = decideSpokenTurn('item-w', word, new Set());
    assert.equal(decision.kind, 'accepted', `"${word}" must be accepted`);
  }
});

test('accepts "Tomorrow is the 9th of Av."', () => {
  const decision = decideSpokenTurn('item-av', 'Tomorrow is the 9th of Av.', new Set());
  assert.equal(decision.kind, 'accepted');
});

test('a duplicate item_id on the SECOND call is idempotent — never re-classified, no matter the content', () => {
  const seen = new Set<string>();
  const first = decideSpokenTurn('item-dup', 'A perfectly normal sentence right here.', seen);
  assert.equal(first.kind, 'accepted');

  const second = decideSpokenTurn('item-dup', 'A perfectly normal sentence right here.', seen);
  assert.equal(second.kind, 'duplicate', 'the same item_id must short-circuit before classification runs again');
});

test('a duplicate item_id short-circuits even for what would otherwise be a rejection', () => {
  const seen = new Set<string>();
  const first = decideSpokenTurn('item-dup2', 'お願いします。', seen);
  assert.equal(first.kind, 'rejected');

  const second = decideSpokenTurn('item-dup2', 'お願いします。', seen);
  assert.equal(second.kind, 'duplicate', 'a duplicate must not re-trigger a second reject/delete cycle');
});

test('two DIFFERENT item_ids are each classified independently, not conflated', () => {
  const seen = new Set<string>();
  const a = decideSpokenTurn('item-a', 'Yes', seen);
  const b = decideSpokenTurn('item-b', 'お願いします。', seen);
  assert.equal(a.kind, 'accepted');
  assert.equal(b.kind, 'rejected');
});

test('a missing item_id (undefined) is never treated as a duplicate of anything', () => {
  const seen = new Set<string>();
  const first = decideSpokenTurn(undefined, 'Yes', seen);
  const second = decideSpokenTurn(undefined, 'Yes', seen);
  assert.equal(first.kind, 'accepted');
  assert.equal(second.kind, 'accepted', 'without an item_id there is nothing to key idempotency on — must not silently drop it');
});

test('language/duration options pass through to the underlying classifier', () => {
  const englishReject = decideSpokenTurn('item-l1', 'お願いします。', new Set(), { language: 'en' });
  assert.equal(englishReject.kind, 'rejected');

  const japaneseAccept = decideSpokenTurn('item-l2', 'お願いします。', new Set(), { language: 'ja' });
  assert.equal(japaneseAccept.kind, 'accepted');

  const tooShort = decideSpokenTurn('item-l3', 'Thanks', new Set(), { speechDurationMs: 40 });
  assert.equal(tooShort.kind, 'rejected');
  if (tooShort.kind === 'rejected') assert.equal(tooShort.result.reason, 'too_short_duration');
});

test('required: barge-in — a tool-call result tagged with an OLDER turnId than the current turn is stale and must be dropped', () => {
  // Simulates: turn 1 issues a tool call, the user barges in (turn advances
  // to 2) before it resolves, the tool call's late result arrives tagged
  // with turnId 1 — it must never be rendered or executed as if current.
  assert.equal(isStaleTurn(1, 2), true);
});

test('a tool-call result tagged with the CURRENT turnId is not stale', () => {
  assert.equal(isStaleTurn(2, 2), false);
});
