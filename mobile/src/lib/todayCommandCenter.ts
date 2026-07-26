// Safe accessors for BriefingData.todayCommandCenter (see backend
// brain/todayCommandCenter.js). Centralized here (not several separate inline
// `d?.todayCommandCenter?.x ?? y` expressions scattered across App.tsx) so
// there is exactly ONE place that defines "what does an older, cached
// briefing payload from before this field (or an older sub-field) existed
// look like" — mobile never recomputes risk, sinceMorning, radar ranking, or
// plan conflicts itself; it only ever reads what the server already
// decided, or degrades to empty/null when the field is absent.
import type { BriefingData, TodayRisk, SinceMorningItem, RadarCard, PlanConflict } from '../hooks/useBriefing';

export interface TodayCommandCenterView {
  risk: TodayRisk | null;
  sinceMorning: SinceMorningItem[];
  radar: RadarCard[];
  planConflict: PlanConflict | null;
}

const EMPTY_VIEW: TodayCommandCenterView = { risk: null, sinceMorning: [], radar: [], planConflict: null };

/** Pure: never throws, regardless of how old/incomplete `data` is — a
 *  briefing payload hydrated from an AsyncStorage cache written before
 *  todayCommandCenter (or one of its newer sub-fields, like `radar` /
 *  `planConflict`) existed simply has no such key, and this must degrade to
 *  the same empty view as "nothing to show" rather than crash the Today
 *  screen. An OLD payload with the retired `previews` array (pre-radar) is
 *  also handled: `radar` just isn't present on it, same as any other
 *  missing field. */
export function selectTodayCommandCenter(data: BriefingData | null | undefined): TodayCommandCenterView {
  const tcc = data?.todayCommandCenter;
  if (!tcc) return EMPTY_VIEW;
  return {
    risk: tcc.risk ?? null,
    sinceMorning: Array.isArray(tcc.sinceMorning) ? tcc.sinceMorning : [],
    radar: Array.isArray(tcc.radar) ? tcc.radar : [],
    planConflict: tcc.planConflict ?? null,
  };
}
