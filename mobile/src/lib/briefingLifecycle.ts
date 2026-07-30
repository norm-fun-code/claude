import type { BriefingData } from '../hooks/useBriefing.ts';
import { mergeBriefingResponse } from './briefingMerge.ts';
import type { RebuildIdentity } from './rebuildResume.ts';
import { adoptRecoveryBuildFromResponse } from './rebuildResume.ts';

export interface BriefingDataCoordinator {
  current: () => BriefingData | null;
  hydrate: (cached: BriefingData) => boolean;
  commitIncoming: (incoming: BriefingData) => BriefingData;
  replaceVerified: (verified: BriefingData) => BriefingData;
  flush: () => Promise<void>;
}

interface CoordinatorOptions {
  onState: (next: BriefingData) => void;
  persist: (next: BriefingData) => Promise<void>;
}

/**
 * Owns the exact BriefingData object shared by React state and AsyncStorage.
 *
 * React functional state updaters are intentionally not used as a source of
 * truth here: React may run them after the surrounding function continues,
 * which previously allowed the raw failed response to be cached while the UI
 * later rendered a last-good merge. This coordinator resolves the merge
 * synchronously, sends that same object to state, and serializes cache writes
 * so an older slow write cannot land after a newer one.
 */
export function createBriefingDataCoordinator({
  onState,
  persist,
}: CoordinatorOptions): BriefingDataCoordinator {
  let value: BriefingData | null = null;
  let hasLiveCommit = false;
  let writeQueue: Promise<void> = Promise.resolve();

  const apply = (next: BriefingData, shouldPersist: boolean): BriefingData => {
    value = next;
    onState(next);
    if (shouldPersist) {
      hasLiveCommit = true;
      writeQueue = writeQueue
        .catch(() => undefined)
        .then(() => persist(next))
        .catch(() => undefined);
    }
    return next;
  };

  return {
    current: () => value,

    // A late AsyncStorage read must never replace a live network/push result
    // that committed while cold-launch hydration was still in flight.
    hydrate(cached) {
      if (hasLiveCommit) return false;
      apply(cached, false);
      return true;
    },

    commitIncoming(incoming) {
      return apply(mergeBriefingResponse(value, incoming), true);
    },

    replaceVerified(verified) {
      return apply(verified, true);
    },

    flush: () => writeQueue,
  };
}

/**
 * The complete client-side handling contract for a successful GET /briefing:
 * synchronously resolve display state, adopt any exact self-heal job, and
 * finish the serialized cache write before declaring the response handled.
 */
export async function applyFetchedBriefingResponse(
  response: BriefingData,
  coordinator: BriefingDataCoordinator,
  persistRecovery: (identity: RebuildIdentity) => Promise<void>,
  pollRecovery: ((buildId: string, localDay: string) => void) | null
): Promise<{ merged: BriefingData; adoptedRecoveryBuild: boolean }> {
  const merged = coordinator.commitIncoming(response);
  const adoptedRecoveryBuild = pollRecovery
    ? await adoptRecoveryBuildFromResponse(response, persistRecovery, pollRecovery)
    : false;
  await coordinator.flush();
  return { merged, adoptedRecoveryBuild };
}

/**
 * Synchronous single-flight gate for controls whose React `loading` state
 * does not update until the next render. Two taps in one event loop therefore
 * cannot start two requests.
 */
export function createImmediateRequestGate() {
  let active = false;
  return {
    tryEnter(): boolean {
      if (active) return false;
      active = true;
      return true;
    },
    markActive() {
      active = true;
    },
    leave() {
      active = false;
    },
    isActive: () => active,
  };
}
