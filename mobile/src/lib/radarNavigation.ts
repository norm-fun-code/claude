// Pure decision logic for "On My Radar"'s secondary navigation (Today Part
// 4/5: "Secondary navigation deep-links to the exact domain entity or
// anchor... if the exact entity no longer exists, degrade gracefully to the
// closest relevant section — not the arbitrary top of the tab"). Extracted
// out of App.tsx so this decision is unit-testable without an RN renderer
// (this repo's mobile test stack only runs pure .ts modules — see
// package.json's `test` script).
import type { RadarDestination } from '../hooks/useBriefing';

export type RadarNavigationResult =
  | { kind: 'review' }
  | { kind: 'tab'; tab: 'health' | 'wealth'; anchor: { entityType: string | null; entityId: string } | null }
  | { kind: 'fallback'; tab: string };

/** Pure: never throws. `destination.surface` decides the branch; a present,
 *  non-empty `entityId` becomes an anchor for the destination tab to
 *  highlight/scroll to (RecoveryCard / InsightsCard's highlight props in
 *  App.tsx) — absent, it degrades to a plain tab switch (the closest
 *  relevant section, never a crash or silent no-op). */
export function resolveRadarNavigation(destination: RadarDestination): RadarNavigationResult {
  if (destination.surface === 'review') return { kind: 'review' };
  if (destination.surface === 'health' || destination.surface === 'wealth') {
    return {
      kind: 'tab',
      tab: destination.surface,
      anchor: destination.entityId ? { entityType: destination.entityType, entityId: destination.entityId } : null,
    };
  }
  return { kind: 'fallback', tab: destination.fallbackRoute || 'today' };
}
