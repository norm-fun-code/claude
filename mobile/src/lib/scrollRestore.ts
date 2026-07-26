// Pure decision logic for Today's scroll-position preservation (Today Part
// 4: "Preserve Today's scroll position when returning"). All tabs share ONE
// ScrollView (see App.tsx) — switching away always snaps to the top (the
// existing, unrelated behavior for every other tab transition), but
// returning to Today specifically restores exactly where it was left,
// rather than snapping to 0 like a fresh tab.
export function nextScrollY(tab: string, prevTab: string, todayScrollY: number): number {
  if (tab === 'today' && prevTab !== 'today') return todayScrollY;
  return 0;
}
