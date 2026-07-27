// Pure types + helpers for the AskResponse contract (backend/src/chat/askResponse.js).
// No React, no fetch — testable with `node --experimental-strip-types --test`.

export type AskIntent = 'understand' | 'decide' | 'act';

export interface EvidenceItem {
  factId: string;
  statement: string;
  value: unknown;
  displayValue: unknown;
  source: string | null;
  period: { from: string | null; to: string | null } | null;
  asOf: string | null;
  freshness: 'fresh' | 'stale';
  evidenceTier: string;
  confidence: number | null;
}

export interface ProposedAction {
  actionType: string;
  title: string;
  preview: string;
  validatedPayload: Record<string, unknown> & { action: string };
  requiresConfirmation: boolean;
  reversibility: string;
  executed: boolean;
  executionResult: { done: boolean; description: string } | null;
}

export interface AskResponse {
  responseId: string;
  conversationId: number | null;
  snapshotId: string | null;
  snapshotVersion: number | null;
  snapshotAt: string | null;
  intent: AskIntent;
  directAnswer: string;
  reasoningSummary: string | null;
  evidence: EvidenceItem[];
  uncertainties: string[];
  proposedActions: ProposedAction[];
  followUps: string[];
  generatedAt: string;
}

/** Actions that still need an explicit tap before they touch real state —
 *  the ones AskOverlay should render as a confirm card. */
export function pendingConfirmations(response: AskResponse | null | undefined): ProposedAction[] {
  if (!response) return [];
  return response.proposedActions.filter((a) => a.requiresConfirmation && !a.executed);
}

const INTENT_LABEL: Record<AskIntent, string> = {
  understand: 'Understand',
  decide: 'Decide',
  act: 'Act',
};

export function intentLabel(intent: AskIntent | null | undefined): string {
  return intent ? (INTENT_LABEL[intent] ?? '') : '';
}
