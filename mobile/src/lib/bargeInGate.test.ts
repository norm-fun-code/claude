// Regression tests for the duration-gated barge-in cancellation. Run via:
//   node --experimental-strip-types --test src/lib/bargeInGate.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBargeInGate } from './bargeInGate.ts';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('sustained speech past the gate duration triggers the cancellation callback', async () => {
  const gate = createBargeInGate(20);
  let cancelled = false;
  gate.speechStarted(() => { cancelled = true; });
  await wait(50);
  assert.equal(cancelled, true, 'speech that outlasts the gate must trigger cancellation');
});

test('a brief blip that stops before the gate elapses never triggers cancellation', async () => {
  const gate = createBargeInGate(40);
  let cancelled = false;
  gate.speechStarted(() => { cancelled = true; });
  gate.speechStopped(); // stops almost immediately — well before the 40ms gate
  await wait(80);
  assert.equal(cancelled, false, 'a blip shorter than the gate must not cancel the response');
});

test('normal barge-in still works promptly: cancellation fires close to the gate duration, not late', async () => {
  const gateMs = 30;
  const gate = createBargeInGate(gateMs);
  const startedAt = Date.now();
  let firedAt: number | null = null;
  gate.speechStarted(() => { firedAt = Date.now(); });
  await wait(gateMs + 60);
  assert.ok(firedAt != null, 'cancellation must have fired');
  const elapsed = (firedAt as unknown as number) - startedAt;
  // Generous upper bound for test-runner scheduling jitter — the point is
  // "promptly", not "instantly": it must not be stuck behind a long cooldown.
  assert.ok(elapsed < gateMs + 100, `expected cancellation within ~${gateMs}ms, took ${elapsed}ms`);
});

test('dispose() cancels a pending timer so it never fires', async () => {
  const gate = createBargeInGate(20);
  let cancelled = false;
  gate.speechStarted(() => { cancelled = true; });
  gate.dispose();
  await wait(50);
  assert.equal(cancelled, false, 'dispose must prevent a pending gate from ever firing');
});

test('speechStopped() with no pending timer is a safe no-op', () => {
  const gate = createBargeInGate(20);
  assert.doesNotThrow(() => gate.speechStopped());
});

test('a second speechStarted() before the gate elapses restarts the timer against the newer callback', async () => {
  // Margins are deliberately wide: this asserts ORDERING (the superseded
  // callback never fires), not timing precision. The original 30ms gate with
  // a 10ms wait raced the event-loop scheduler — a loaded CI runner could
  // overshoot 30ms during that "well before" wait, letting the first gate
  // elapse and flipping the assertion. Flaked CI this way with no relation
  // to the change under test.
  const gate = createBargeInGate(300);
  let firstFired = false;
  let secondFired = false;
  gate.speechStarted(() => { firstFired = true; });
  await wait(20); // well before the first 300ms gate could elapse, even under load
  gate.speechStarted(() => { secondFired = true; });
  await wait(600);
  assert.equal(firstFired, false, 'the first (superseded) callback must never fire');
  assert.equal(secondFired, true, 'the second (current) callback must fire');
});
