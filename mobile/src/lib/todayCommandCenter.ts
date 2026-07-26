// Safe accessors for BriefingData.todayCommandCenter (see backend
// brain/todayCommandCenter.js). Centralized here (not three separate inline
// `d?.todayCommandCenter?.x ?? y` expressions scattered across App.tsx) so
// there is exactly ONE place that defines "what does an older, cached
// briefing payload from before this field existed look like" — mobile never
// recomputes risk, sinceMorning, or previews itself; it only ever reads
// what the server already decided, or degrades to empty/null when the
// field is absent.
import type { BriefingData, TodayRisk, SinceMorningItem, TodayPreview } from '../hooks/useBriefing';

export interface TodayCommandCenterView {
  risk: TodayRisk | null;
  sinceMorning: SinceMorningItem[];
  previews: TodayPreview[];
}

const EMPTY_VIEW: TodayCommandCenterView = { risk: null, sinceMorning: [], previews: [] };

/** Pure: never throws, regardless of how old/incomplete `data` is — a
 *  briefing payload hydrated from an AsyncStorage cache written before
 *  todayCommandCenter existed simply has no `todayCommandCenter` key at
 *  all, and this must degrade to the same empty view as "nothing to show"
 *  rather than crash the Today screen. */
export function selectTodayCommandCenter(data: BriefingData | null | undefined): TodayCommandCenterView {
  const tcc = data?.todayCommandCenter;
  if (!tcc) return EMPTY_VIEW;
  return {
    risk: tcc.risk ?? null,
    sinceMorning: Array.isArray(tcc.sinceMorning) ? tcc.sinceMorning : [],
    previews: Array.isArray(tcc.previews) ? tcc.previews : [],
  };
}
