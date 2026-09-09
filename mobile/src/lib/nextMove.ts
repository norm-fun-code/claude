/** User-authored planning tools. Never derives or overwrites canonical life facts. */
export type DecisionLens = 'balance' | 'time' | 'energy' | 'money';
export interface DecisionDraft {
  question: string;
  optionA: string;
  optionB: string;
  constraint: string;
  lens: DecisionLens;
}
export const EMPTY_DECISION: DecisionDraft = { question: '', optionA: '', optionB: '', constraint: '', lens: 'balance' };
export const LENSES: Record<DecisionLens, string> = {
  balance: 'Whole life', time: 'Time & attention', energy: 'Energy', money: 'Money',
};

export function decisionError(d: DecisionDraft): string | null {
  if (!d.question.trim()) return 'Name the decision you want to make.';
  if (!d.optionA.trim() || !d.optionB.trim()) return 'Add two options to compare.';
  if (d.optionA.trim().toLowerCase() === d.optionB.trim().toLowerCase()) return 'Give each option a different direction.';
  return null;
}

export function decisionPrompt(d: DecisionDraft): string {
  if (decisionError(d)) return '';
  return [
    'Decision Studio — explore only',
    'Help me think through a decision. This is exploration, not a request to execute actions or save new facts about me.',
    `Decision: ${d.question.trim()}`,
    `Option A: ${d.optionA.trim()}`,
    `Option B: ${d.optionB.trim()}`,
    `Prioritize: ${LENSES[d.lens]}.`,
    d.constraint.trim() ? `My constraints / what matters: ${d.constraint.trim()}` : '',
    'Use my available current context, commitments, goals and relevant past experience. Identify stale or missing evidence; do not invent numbers or treat these hypothetical options as events that happened.',
    'Give me: a concise side-by-side comparison; the strongest case against your preferred option; what would change the recommendation; and one small, reversible next step. Distinguish known facts from assumptions. If a critical detail is missing, ask one focused question. Keep it practical and easy to scan.',
  ].filter(Boolean).join('\n\n');
}

export const FOCUS_STORAGE_KEY = 'normos.focus.v1';
export interface FocusSession {
  version: 1;
  title: string;
  durationMs: number;
  remainingMs: number;
  endsAt: number | null;
  startedAt: number;
}
export function startFocus(title: string, minutes: number, now: number): FocusSession {
  if (!title.trim() || ![15, 25, 45].includes(minutes) || !Number.isFinite(now)) throw new Error('Choose a focus and duration.');
  const durationMs = minutes * 60000;
  return { version: 1, title: title.trim().slice(0, 500), durationMs, remainingMs: durationMs, endsAt: now + durationMs, startedAt: now };
}
export function focusRemaining(s: FocusSession, now: number): number {
  return Math.max(0, Math.min(s.durationMs, s.endsAt === null ? s.remainingMs : s.endsAt - now));
}
export function pauseFocus(s: FocusSession, now: number): FocusSession {
  return { ...s, remainingMs: focusRemaining(s, now), endsAt: null };
}
export function resumeFocus(s: FocusSession, now: number): FocusSession {
  const remainingMs = focusRemaining(s, now);
  return { ...s, remainingMs, endsAt: remainingMs > 0 ? now + remainingMs : null };
}
export function restoreFocus(raw: string | null): FocusSession | null {
  try {
    const s = JSON.parse(raw ?? 'null');
    if (!s || s.version !== 1 || typeof s.title !== 'string' || !s.title.trim() || s.title.length > 500) return null;
    if (![900000, 1500000, 2700000].includes(s.durationMs)) return null;
    if (!Number.isFinite(s.remainingMs) || s.remainingMs < 0 || s.remainingMs > s.durationMs) return null;
    if (!Number.isFinite(s.startedAt) || s.startedAt < 0) return null;
    if (s.endsAt !== null && (!Number.isFinite(s.endsAt) || s.endsAt < s.startedAt)) return null;
    return { version: 1, title: s.title, durationMs: s.durationMs, remainingMs: s.remainingMs, endsAt: s.endsAt, startedAt: s.startedAt };
  } catch { return null; }
}
export function focusClock(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
