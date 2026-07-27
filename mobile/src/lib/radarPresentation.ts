// Pure semantic presentation for "On My Radar" cards — the ONE place that
// maps a server-declared `attentionClass` to a color token name and a
// user-facing label. Extracted so it's unit-testable without an RN renderer
// (same reasoning as radarNavigation.ts) and so RadarSection.tsx and
// RadarDetailSheet.tsx can never independently reinterpret the same status
// two different ways (the exact defect this module exists to prevent: a
// POSITIVE wealth result rendering as a red "Needs attention" alert because
// severity was invented from array position instead of read from the server).
import type { RadarAttentionClass } from '../hooks/useBriefing';

export type RadarColorToken = 'red' | 'yellow' | 'purple' | 'green' | 'subtext';

export interface RadarPresentation {
  colorToken: RadarColorToken;
  label: string;
}

const PRESENTATION: Record<string, RadarPresentation> = {
  action_required: { colorToken: 'red', label: 'Needs attention' },
  watch: { colorToken: 'yellow', label: 'Worth watching' },
  ready: { colorToken: 'purple', label: 'Ready for you' },
  positive: { colorToken: 'green', label: 'Good news' },
  informational: { colorToken: 'subtext', label: 'For your awareness' },
};

const FALLBACK: RadarPresentation = { colorToken: 'subtext', label: 'For your awareness' };

/** Pure, total: an unrecognized/missing attentionClass degrades to the
 *  quietest possible presentation (neutral color, informational label) —
 *  never defaults to red. A card server-side should never actually carry
 *  'informational' (radar.js excludes those before ranking), but this stays
 *  total so a future/older payload can't crash or misrender as an alert. */
export function presentationForAttentionClass(attentionClass: RadarAttentionClass | string | null | undefined): RadarPresentation {
  if (!attentionClass) return FALLBACK;
  return PRESENTATION[attentionClass] || FALLBACK;
}
