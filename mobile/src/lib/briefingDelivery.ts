import type { BriefingData } from '../hooks/useBriefing.ts';
import { isUsableChiefBrief } from './briefingMerge.ts';
import { isValidReadyResult } from './rebuildResume.ts';

/** A successful HTTP envelope is not proof that today's brief is on screen. */
export function needsBriefingDelivery(data: BriefingData | null | undefined, today: string): boolean {
  if (!data || (data.localDate && data.localDate !== today) || data.dayState === 'previous_day') return true;
  if (!isUsableChiefBrief(data.chiefBrief) || data.chiefBriefPending || data.chiefBriefStale || data.chiefBriefGoalsStale || data.publishTier === 'hard_failed') return true;
  return data.publishTier !== 'grounded_usable' && (data.chiefBriefQuality?.status === 'failed' || data.chiefBriefQuality?.status === 'degraded');
}

/** Async work retains a ticket. Reopening, a new job or a push invalidates it. */
export function createDeliveryGeneration() {
  let generation = 0;
  return {
    next: () => ++generation,
    isCurrent: (ticket: number) => ticket === generation,
  };
}

/** Resolve a published build, tolerating transient replica/network gaps.
 * The acceptance callback is never called by cancelled or invalid deliveries. */
export async function deliverPublishedBriefing({ read, accept, isCurrent, today, localDay, snapshotId, wait }: {
  read: () => Promise<BriefingData | null>;
  accept: (content: BriefingData) => void;
  isCurrent: () => boolean;
  today: () => string;
  localDay: string;
  snapshotId?: string | null;
  wait: () => Promise<void>;
}): Promise<BriefingData | null> {
  for (let attempt = 0; attempt < 3 && isCurrent(); attempt++) {
    if (localDay !== today()) return null;
    const content = await read().catch(() => null);
    if (!isCurrent()) return null;
    if (localDay !== today()) return null;
    if (isValidReadyResult(content, localDay, snapshotId)) {
      accept(content!);
      return content;
    }
    if (attempt < 2) await wait();
  }
  return null;
}
