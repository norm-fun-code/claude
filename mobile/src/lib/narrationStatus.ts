// Pure, shared narration wording. The old cards exposed a spinner with no
// status, then called every failure "Unavailable"; that made a legitimate
// cold synthesis look permanent and gave no clear retry affordance.
export type NarrationState = 'idle' | 'loading' | 'preparing' | 'playing' | 'error';
export type NarrationErrorKind = 'not_found' | 'narration_failed' | null;

export function narrationButtonLabel(state: NarrationState, errorKind: NarrationErrorKind = null): string {
  if (state === 'playing') return '◼ Stop';
  if (state === 'loading' || state === 'preparing') return 'Preparing…';
  if (state === 'error') return errorKind === 'not_found' ? 'Not found' : 'Try again';
  return '▶ Listen';
}

export function isNarrationBusy(state: NarrationState): boolean {
  return state === 'loading' || state === 'preparing';
}
