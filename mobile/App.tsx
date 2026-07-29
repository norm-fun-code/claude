import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useFonts, Sora_300Light, Sora_600SemiBold, Sora_700Bold, Sora_800ExtraBold } from '@expo-google-fonts/sora';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
import {
  ScrollView,
  StyleSheet,
  View,
  RefreshControl,
  Text,
  TouchableOpacity,
  useColorScheme,
  ActivityIndicator,
  SafeAreaView,
  Platform,
  useWindowDimensions,
  AppState,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { AnimatedEntry } from './src/components/AnimatedEntry';

// NormOS follows the system appearance by default; a stored user override
// (Auto / Light / Dark, toggled in the header) is applied before first paint —
// see the themeReady gate below, alongside fontsLoaded.
import { loadThemePref } from './src/theme-pref';

import { useBriefing } from './src/hooks/useBriefing';
import { useEveningBrief } from './src/hooks/useEveningBrief';
import { useHealthData } from './src/hooks/useHealthData';
import { useRecovery } from './src/hooks/useRecovery';
import { usePushRegistration } from './src/hooks/usePushRegistration';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, shadow, radius, FONTS } from './src/theme';

import { Header } from './src/components/Header';
import { TabBar, TabKey, TABS } from './src/components/TabBar';
import { WealthPostureCard } from './src/components/WealthPostureCard';
import { WealthWhatChangedCard } from './src/components/WealthWhatChangedCard';
import { WealthActionCard } from './src/components/WealthActionCard';
import { WealthExploreScreen } from './src/components/WealthExploreScreen';
import { AskOverlay, type AskOverlayHandle } from './src/components/AskOverlay';
import { CheckinModal } from './src/components/CheckinModal';
import { WeeklyReviewModal } from './src/components/WeeklyReviewModal';
import { LinearGradient } from 'expo-linear-gradient';
import { NightContextCard } from './src/components/NightContextCard';
import { SleepCheckInCard } from './src/components/SleepCheckInCard';
import { HealthStateCard } from './src/components/HealthStateCard';
import { HealthCard } from './src/components/HealthCard';
import { TrainingSummaryCard } from './src/components/TrainingSummaryCard';
import { WorthKnowingCard } from './src/components/WorthKnowingCard';
import { TrainingScreen } from './src/components/TrainingScreen';
import { PatternsExperimentsScreen } from './src/components/PatternsExperimentsScreen';
import { HealthHistoryScreen } from './src/components/HealthHistoryScreen';
import { QuoteCard } from './src/components/QuoteCard';
import { NotionCard } from './src/components/NotionCard';
import { WisdomListenCard } from './src/components/WisdomListenCard';
import { AlertCard } from './src/components/AlertCard';
import { HighlightsCard } from './src/components/HighlightsCard';
import { BriefCard } from './src/components/BriefCard';
import { EveningBriefCard } from './src/components/EveningBriefCard';
import { WelcomeScreen } from './src/components/WelcomeScreen';
import { SkeletonCard } from './src/components/viz/Skeleton';
import { BriefSignalsCard } from './src/components/BriefSignalsCard';
import { CrossContextCard } from './src/components/CrossContextCard';
import { CollapsibleSection } from './src/components/CollapsibleSection';
import { HabitsModal } from './src/components/HabitsModal';
import { LibraryCard } from './src/components/LibraryCard';
import { CommitmentsCard } from './src/components/CommitmentsCard';
import { SinceMorningCard } from './src/components/SinceMorningCard';
import { RadarSection } from './src/components/RadarSection';
import { RadarDetailSheet } from './src/components/RadarDetailSheet';
import { PlanConflictCard } from './src/components/PlanConflictCard';
import { selectTodayCommandCenter } from './src/lib/todayCommandCenter';
import { resolveRadarNavigation } from './src/lib/radarNavigation';
import { nextScrollY } from './src/lib/scrollRestore';
import type { RadarCard, WeeklyReview } from './src/hooks/useBriefing';
import { resolveWeeklyReviewSource } from './src/lib/openWeeklyReview';
import { WORKOUT_OVERRIDE_URL, CHIEF_BRIEF_REBUILD_URL, INSIGHT_DISMISS_URL, WEEKLY_REVIEW_URL, authHeaders, fetchWithTimeout } from './src/config';
import { useDailyLogStatus } from './src/hooks/useDailyLogStatus';
import { useCommitments } from './src/hooks/useCommitments';

// A single stable empty-array reference for `d?.field ?? []`-style fallbacks
// passed to memoized cards — `?? []` mints a NEW array every render, which
// defeats React.memo on whatever card receives it (a fresh reference always
// looks like a prop change). Safe to share across every such fallback since
// none of these cards ever mutate the array they're given.
const EMPTY_ARRAY: never[] = [];

// Context-aware one-tap questions for the voice/quick-ask summon — grounded in
// live numbers where we have them so the starters feel like they're actually
// looking at the same screen you are, not a generic prompt. Shared by the
// long-press-the-Ask-tab gesture and the mic FAB (both just open the same
// summon sheet from a different entry point).
function contextStartersFor(
  tab: TabKey,
  opts: { score?: number | null; band?: string | null; risk?: string | null }
): string[] {
  const { score, band, risk } = opts;
  if (tab === 'health') {
    return [
      score != null ? `Why is my recovery ${score} (${band ?? 'unknown'}) today?` : 'Why is my recovery where it is today?',
      "What's been moving my HRV lately?",
      "Should I adjust today's workout given my recovery?",
    ];
  }
  if (tab === 'wealth') {
    return [
      'How is my spending pacing this month?',
      'What changed in my net worth recently?',
      'Where am I overspending vs my usual?',
    ];
  }
  if (tab === 'wisdom') {
    return [
      "Connect today's quote to what my data shows this week",
      'What from my library should I revisit right now?',
    ];
  }
  return [ // today
    "What's the single most important thing right now?",
    risk ? 'Go deeper on the risk in my brief' : "What am I missing in today's plan?",
    'How are my weekly goals tracking?',
  ];
}

export default function App() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  // Home-indicator height, RN-only (no safe-area-context dependency). iPhone X+
  // (>= 812pt tall) have a ~34pt home indicator; older devices have none. Used to
  // anchor the tab bar flush to the screen bottom, filling the curved corner area.
  const { height: winH } = useWindowDimensions();
  const bottomInset = Platform.OS === 'ios' && winH >= 812 ? 34 : 0;

  const briefing = useBriefing();
  const eveningBrief = useEveningBrief();
  const health = useHealthData();
  const liveRecovery = useRecovery();
  const [fontsLoaded] = useFonts({
    Sora_300Light, Sora_600SemiBold, Sora_700Bold, Sora_800ExtraBold,
    Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold,
    ...Ionicons.font, // preload tab-bar icon glyphs so they don't flash in
  });
  // Gate first paint on the stored theme preference too, not just fonts —
  // otherwise a fast font load could render one frame in the OS scheme before
  // a stored Light/Dark override applies.
  const [themeReady, setThemeReady] = useState(false);
  useEffect(() => { loadThemePref().then(() => setThemeReady(true)); }, []);

  const [tab, setTab] = useState<TabKey>('today');
  // All tabs share ONE ScrollView (only its contents swap), so switching tabs
  // never reset scroll on its own — it stayed wherever the previous tab left it.
  // Snap to top whenever the active tab changes — EXCEPT returning to Today
  // specifically (e.g. after "Open in Health" from a radar card's secondary
  // nav), which restores exactly where Today was left (todayScrollYRef,
  // updated on every Today scroll event below) rather than snapping to 0.
  const scrollRef = useRef<ScrollView>(null);
  const todayScrollYRef = useRef(0);
  const prevTabRef = useRef<TabKey>('today');
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: nextScrollY(tab, prevTabRef.current, todayScrollYRef.current), animated: false });
    prevTabRef.current = tab;
  }, [tab]);
  const onScrollTrackToday = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (tab === 'today') todayScrollYRef.current = e.nativeEvent.contentOffset.y;
  }, [tab]);
  // Summonable Ask: long-press the Ask tab from anywhere to open the chat as a
  // sheet ABOVE the current tab — ask without losing your place.
  const quickAskRef = useRef<AskOverlayHandle>(null);
  // Evening layout mode, LATCHED once per app session when the evening-brief
  // fetch first resolves. Deliberately not live: if it flipped the moment the
  // 9:30pm brief lands, the morning BriefCard would swap subtrees mid-use and
  // remount — wiping a half-typed context note and collapsing the card under
  // the user's finger. A session that starts in the morning stays morning-
  // shaped; the next open (evening) gets the evening layout.
  const [eveningMode, setEveningMode] = useState<boolean | null>(null);
  useEffect(() => {
    if (eveningMode === null && eveningBrief.fetched) setEveningMode(!!eveningBrief.brief);
  }, [eveningMode, eveningBrief.fetched, eveningBrief.brief]);
  // A session that started before the evening brief existed (app opened during
  // the day, never force-quit) would otherwise stay morning-shaped all night —
  // the one-time latch above only ever fires once, so it locked in `false` and
  // the "This morning's brief" card never collapsed even hours after 9:30pm.
  // Re-check on each return to foreground (a natural "next open," which is what
  // most users actually do instead of force-quitting) — but ONLY false→true,
  // never the reverse, so this can only ever collapse the card, never yank it
  // closed (and remount, wiping unsaved input) out from under someone mid-use.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && eveningMode === false && eveningBrief.brief) setEveningMode(true);
    });
    return () => sub.remove();
  }, [eveningMode, eveningBrief.brief]);
  // Cold-open welcome: shown once per launch (App mount = cold start), it covers
  // the whole feed assembly so the jumpy mount/insert is never seen.
  const [showWelcome, setShowWelcome] = useState(true);
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [habitsOpen, setHabitsOpen] = useState(false);
  // Weekly review's dedicated destination (Today redesign) — opened by
  // tapping the "Weekly review is ready" preview rather than rendering the
  // full review/goals card inline on Today.
  const [weeklyReviewOpen, setWeeklyReviewOpen] = useState(false);
  // Weekly-review CTA fix: when the requested review isn't the one already
  // in the briefing payload, `weeklyReviewOverride` holds the fetched
  // review (null = render d?.weeklyReview as before). Session-scoped cache
  // (never persisted) so re-opening the same non-current review within a
  // session doesn't re-fetch; `weeklyReviewFetchSeq` guards a slow/retried
  // fetch from clobbering a newer one.
  const [weeklyReviewOverride, setWeeklyReviewOverride] = useState<WeeklyReview | null>(null);
  const [weeklyReviewLoading, setWeeklyReviewLoading] = useState(false);
  const [weeklyReviewError, setWeeklyReviewError] = useState<string | null>(null);
  const weeklyReviewCache = useRef<Map<string, WeeklyReview>>(new Map());
  const weeklyReviewFetchSeq = useRef(0);
  // The identity of the most recently REQUESTED review — captured even when
  // the fetch fails (so weeklyReviewOverride is still null) — so Retry can
  // re-issue the exact same request rather than losing which review a
  // failed fetch was even for.
  const weeklyReviewLastRequest = useRef<{ reviewId: number | null; weekStart: string | null }>({ reviewId: null, weekStart: null });
  // Health tab redesign (audit rec #4) — the three focused drill-ins, opened
  // as full-screen sheets rather than a new bottom-navigation tab.
  const [trainingOpen, setTrainingOpen] = useState(false);
  // Shared Training drill-in invalidation contract: WorkoutsPanel's six
  // mutation paths (complete/undo, log/remove substitute activity,
  // swap/restore workout, log sets) all write through the backend's
  // existing durable invalidation bus (bumpDurable), but nothing called
  // back up to the parent to refetch what TrainingSummaryCard reads. Rather
  // than a callback per mutation type, one contract covers all of them:
  // closing the drill-in (a) reloads the briefing so `d.effectiveWorkout`
  // picks up the version-gated cheap re-derivation the backend already does,
  // and (b) bumps this generation counter so TrainingSummaryCard's own
  // completion fetch re-fires even when workoutId itself didn't change
  // (e.g. a same-workout complete/undo toggle).
  const [trainingRefreshGen, setTrainingRefreshGen] = useState(0);
  const [patternsOpen, setPatternsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [wealthExploreOpen, setWealthExploreOpen] = useState(false);
  const [pendingAskQ, setPendingAskQ] = useState('');
  const dailyLog = useDailyLogStatus();
  const commitments = useCommitments();
  // Health tab refresh only spins on health-local fetches; other tabs include
  // briefing loading AND any async rebuild in progress.
  const isRefreshing =
    tab === 'health'
      ? health.loading || liveRecovery.loading
      : briefing.loading || briefing.rebuilding || health.loading;

  // Pull-to-refresh is always CHEAP: device HealthKit (instant) + the warm
  // server cache (instant) + the fast recovery endpoint on Health. Nothing here
  // triggers an LLM or a briefing rebuild — that's Wealth's "Rebuild briefing"
  // button (see tabRefresh below) and BriefCard's own scoped ↻.
  const onRefresh = useCallback(() => {
    health.refetch();
    if (tab === 'health') liveRecovery.refetch();
    else briefing.reload();
  }, [briefing, health, liveRecovery, tab]);

  const d = briefing.data;

  // Shared by both SleepCheckInCard instances (Health tab + Today tab) — a
  // stable reference so the memoized card doesn't see a "new" callback prop
  // on every render.
  const onSleepLogged = useCallback(() => {
    liveRecovery.refetch();
    briefing.triggerRebuild();
  }, [liveRecovery, briefing]);

  // Refresh-mechanism consolidation (product review: "five refresh concepts is
  // four too many"). Health's old "Refresh health data" button and Wisdom's old
  // "Reload" button called the EXACT same functions pull-to-refresh already
  // calls on those tabs — pure redundant UI, removed. What's left, deliberately:
  //   - Pull-to-refresh (cheap, every tab): device HealthKit + warm server cache.
  //   - Wealth's "Rebuild briefing" (the one full async rebuild, ~60-90s) — the
  //     only tab that exposes it; Today's old duplicate icon was removed too.
  //   - BriefCard's own inline ↻ (refreshChiefBrief, seconds not 60-90s) —
  //     deliberately KEPT despite the "delete the rest" framing: it's the fix
  //     for a real, previously-shipped bug (a silently-stale brief with no fast
  //     retry short of a full rebuild). Removing it would reintroduce that bug.
  const tabRefresh: Partial<Record<TabKey, { label: string; busy: boolean; run: () => void }>> = {
    wealth: { label: 'Rebuild briefing', busy: briefing.rebuilding, run: briefing.triggerRebuild },
  };

  // The canonical weekly-review action (weekly-review CTA fix) — every entry
  // point (On My Radar, Today's "ready for you" card, Weekly Focus, the
  // weekly-review push notification) converges here rather than each one
  // independently deciding how to open a review. Never regenerates the
  // review; identifies it by stable id/weekStart, never by title text or
  // array position (see src/lib/openWeeklyReview.ts's pure decision logic).
  const openWeeklyReview = useCallback(({ reviewId = null, weekStart = null }: { reviewId?: number | null; weekStart?: string | null; origin: string }) => {
    // Prevents duplicate screens from rapid repeated taps — a second call
    // while one is already open/loading is a no-op, not a stacked modal.
    if (weeklyReviewOpen || weeklyReviewLoading) return;
    weeklyReviewLastRequest.current = { reviewId, weekStart };
    const current = d?.weeklyReview ?? null;
    const source = resolveWeeklyReviewSource(current, { reviewId, weekStart }, (key) => weeklyReviewCache.current.has(key));
    if (source.kind === 'current') {
      setWeeklyReviewOverride(null);
      setWeeklyReviewError(null);
      setWeeklyReviewOpen(true);
      return;
    }
    if (source.kind === 'cached') {
      setWeeklyReviewOverride(weeklyReviewCache.current.get(source.cacheKey) ?? null);
      setWeeklyReviewError(null);
      setWeeklyReviewOpen(true);
      return;
    }
    // A genuine fetch is needed — loading state shown only now, never for
    // the already-in-hand cases above.
    const seq = ++weeklyReviewFetchSeq.current;
    setWeeklyReviewOverride(null);
    setWeeklyReviewError(null);
    setWeeklyReviewLoading(true);
    setWeeklyReviewOpen(true);
    const qs = 'id' in source.query ? `id=${encodeURIComponent(String(source.query.id))}` : `weekStart=${encodeURIComponent(source.query.weekStart)}`;
    fetchWithTimeout(`${WEEKLY_REVIEW_URL}?${qs}`, { headers: authHeaders() }, 10000)
      .then(async (res) => {
        if (seq !== weeklyReviewFetchSeq.current) return; // superseded by a newer request
        if (!res.ok) throw new Error(`status_${res.status}`);
        const json = await res.json();
        weeklyReviewCache.current.set(source.cacheKey, json);
        setWeeklyReviewOverride(json);
        setWeeklyReviewLoading(false);
      })
      .catch(() => {
        if (seq !== weeklyReviewFetchSeq.current) return;
        setWeeklyReviewLoading(false);
        setWeeklyReviewError('Could not load this review.');
      });
  }, [weeklyReviewOpen, weeklyReviewLoading, d]);

  const retryWeeklyReview = useCallback(() => {
    const identity = weeklyReviewLastRequest.current;
    setWeeklyReviewOpen(false);
    setWeeklyReviewError(null);
    // Let the close commit before immediately reopening — same reasoning as
    // the Radar-sheet modal-collision fix (see RadarDetailSheet.tsx).
    setTimeout(() => openWeeklyReview({ ...identity, origin: 'retry' }), 0);
  }, [openWeeklyReview]);

  const closeWeeklyReview = useCallback(() => {
    setWeeklyReviewOpen(false);
    setWeeklyReviewError(null);
    setWeeklyReviewLoading(false);
  }, []);

  // Tapping the morning "briefing ready" push should load the cache the server
  // already warmed at 8:30 — instant, not a 15-40s forced rebuild. Health still
  // refreshes from the device.
  const onNotificationTap = useCallback((data: Record<string, unknown>) => {
    const key = typeof data.key === 'string' ? data.key : '';
    const type = typeof data.type === 'string' ? data.type : '';
    if (key.startsWith('habits:')) {
      setHabitsOpen(true);
    } else if (key.startsWith('checkin:')) {
      // The 3pm "10-second check-in" push (nudges.js's checkinReminder, key
      // "checkin:YYYY-MM-DD") had no matching case here, so it fell through to
      // the generic else branch below — a silent briefing/health reload with
      // no visible navigation, which read as the notification just not
      // working. Open the actual check-in modal, same as the habits push.
      setCheckinOpen(true);
    } else if (key.startsWith('day_context')) {
      // "Tell me about your day" → open Ask, prefilled so they can talk it
      // through (hold the mic) or just keep typing.
      quickAskRef.current?.openWith("Today's context: ");
    } else if (type === 'commitment') {
      // Tapping a commitment reminder lands on Today, where the card lives.
      setTab('today');
      commitments.refetch();
    } else if (type === 'evening_health_brief') {
      setTab('today');
      eveningBrief.refetch();
      health.refetch();
    } else if (type === 'weekly_review') {
      // Weekly-review CTA fix: the push carries reviewId/weekStart
      // (backend/src/notify/morning.js's runWeeklyReviewWithPush) so this
      // opens the EXACT review the notification promised via the same
      // canonical action every other entry point uses — never whatever
      // happens to be "latest" if another week's review has since generated.
      setTab('today');
      openWeeklyReview({
        reviewId: typeof data.reviewId === 'number' ? data.reviewId : null,
        weekStart: typeof data.weekStart === 'string' ? data.weekStart : null,
        origin: 'push',
      });
    } else if (type === 'morning_briefing') {
      // Morning-notification lifecycle fix: resolve the EXACT persisted
      // briefing this push referenced (backend/src/notify/morning.js's
      // verified publication receipt), never a generic reload — which used
      // to show whatever stale/cached envelope happened to already be on
      // screen ("Built 23h ago" above an indefinite skeleton) instead of the
      // fresh brief the push promised. Works from a cold (terminated-app)
      // launch too: openFromPush does its own fetch and doesn't depend on
      // initial cache hydration having finished first.
      setTab('today');
      briefing.openFromPush({
        briefingId: typeof data.briefingId === 'string' ? data.briefingId : null,
        snapshotId: typeof data.snapshotId === 'string' ? data.snapshotId : null,
        localDay: typeof data.localDay === 'string' ? data.localDay : null,
        builtAt: typeof data.builtAt === 'string' ? data.builtAt : null,
      });
      health.refetch();
    } else {
      briefing.reload();
      health.refetch();
    }
  }, [briefing, health, eveningBrief, commitments]);

  usePushRegistration(onNotificationTap);

  // Server-decided destinations from todayCommandCenter's sinceMorning[]
  // (see brain/todayCommandCenter.js) — mobile just navigates where it's
  // told, never deciding on its own what an item should link to. 'review'
  // opens the dedicated weekly-review modal instead of a tab switch, since
  // there's no standalone Review tab.
  const navigateFromToday = useCallback((destination: string) => {
    if (destination === 'review') { openWeeklyReview({ origin: 'today_since_morning' }); return; }
    if (destination === 'health' || destination === 'wealth') { setTab(destination); return; }
    // 'today' (or anything unrecognized) — already there, no-op.
  }, [openWeeklyReview]);

  // "On My Radar" (Today Part 4): the card that's currently open in the
  // full-detail sheet (null when closed). `radarAnchor` is the typed deep-
  // link's best-effort entity target — Health/Wealth cards read it to
  // highlight + scroll to the exact insight instead of leaving the user at
  // the arbitrary top of the tab; it self-clears once consumed so revisiting
  // the tab later doesn't keep re-highlighting.
  const [radarDetailCard, setRadarDetailCard] = useState<RadarCard | null>(null);
  const [radarAnchor, setRadarAnchor] = useState<{ entityType: string | null; entityId: string | null } | null>(null);
  const openRadarCard = useCallback((card: RadarCard) => setRadarDetailCard(card), []);
  const closeRadarDetail = useCallback(() => setRadarDetailCard(null), []);

  // Secondary nav from the detail sheet ("Open in Health"/"Open in Wealth"/
  // "Read the review") — degrades gracefully to destination.fallbackRoute
  // (the top of that tab) when there's no anchor to resolve to.
  const openRadarDestination = useCallback((card: RadarCard) => {
    setRadarDetailCard(null);
    const nav = resolveRadarNavigation(card.destination);
    if (nav.kind === 'review') { openWeeklyReview({ reviewId: nav.reviewId, weekStart: nav.weekStart, origin: 'radar' }); return; }
    if (nav.kind === 'tab') { setRadarAnchor(nav.anchor); setTab(nav.tab); return; }
    setTab(nav.tab as TabKey);
  }, [openWeeklyReview]);

  const dismissRadarCard = useCallback((card: RadarCard) => {
    setRadarDetailCard(null);
    if (!card.dismissKey) return;
    fetchWithTimeout(
      INSIGHT_DISMISS_URL,
      { method: 'POST', headers: authHeaders(), body: JSON.stringify({ key: card.dismissKey, title: card.headline }) },
      8000
    ).then(() => briefing.reload()).catch(() => {});
  }, [briefing]);

  // Part 1's plan-conflict resolution: writes an explicit workout override
  // through the SAME existing infrastructure the Health tab's day-swap uses
  // (POST /workout/override — invalidates effectiveWorkout/trainingOutcome/
  // todayForecast already), then resyncs the chief brief against it via the
  // existing scoped-rebuild flow (briefing.refreshChiefBrief, the identical
  // request the manual ↻ button makes) — never a second, parallel mechanism.
  const resolvePlanConflict = useCallback(async (workoutId: string | null) => {
    const date = new Date().toLocaleDateString('en-CA');
    try {
      await fetchWithTimeout(
        WORKOUT_OVERRIDE_URL,
        { method: 'POST', headers: authHeaders(), body: JSON.stringify({ date, workoutId }) },
        10000
      );
    } catch { /* best-effort — refreshChiefBrief below still runs and will reflect whatever the server has */ }
    await briefing.refreshChiefBrief();
  }, [briefing]);

  // Fired once by whichever Health/Wealth card matches radarAnchor's
  // entityType/entityId (RecoveryCard's / WealthWhatChangedCard's
  // onHighlightLayout) — scrolls the shared ScrollView straight to it and
  // consumes the anchor so a later, unrelated visit to the tab doesn't keep
  // re-scrolling. Wealth's "Worth a look" card is capped at 3 items (all
  // visible without further scrolling once the card is in view), so its
  // highlight target is the whole card rather than a single row — see
  // WealthWhatChangedCard's highlight/onHighlightLayout props.
  const onRadarAnchorLayout = useCallback((y: number) => {
    scrollRef.current?.scrollTo({ y: Math.max(0, y - spacing.md), animated: true });
    setRadarAnchor(null);
  }, []);

  // Deep-link fallback (Today Part 4/On My Radar audit item 7): the anchor
  // above is consumed by whichever card matches on its next layout pass —
  // normally near-instant. If the exact entity never renders (e.g. a wealth
  // insight's title drifted between when the Radar card was built and when
  // the user tapped through, or the underlying data was dismissed/removed
  // in the meantime), nothing would ever call onRadarAnchorLayout and the
  // anchor would linger silently, ready to mis-highlight an unrelated later
  // insight. Log the reason and self-clear instead of failing silently —
  // the tab switch itself (already done in openRadarDestination) is the
  // graceful fallback; this only accounts for the highlight/scroll step.
  useEffect(() => {
    if (!radarAnchor) return undefined;
    const timer = setTimeout(() => {
      console.warn(`[radar anchor] entityType=${radarAnchor.entityType ?? 'null'} entityId=${radarAnchor.entityId ?? 'null'} was never matched by a rendered card — falling back to the top of the tab.`);
      setRadarAnchor(null);
    }, 2500);
    return () => clearTimeout(timer);
  }, [radarAnchor]);

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  // YYYY-MM-DD, device-local — comparable against BriefingData.localDate to
  // tell genuinely current content apart from a carried-over cached build
  // from a prior day (see WisdomListenCard's `stale` prop below).
  const todayLocalDate = new Date().toLocaleDateString('en-CA');

  const tabTitle = TABS.find((t) => t.key === tab)?.label ?? '';

  // Non-health/wellbeing-only findings (habit streaks + check-in trends) for
  // CheckinHistoryCard — computed once per d?.insights change instead of a
  // fresh .filter() (and fresh array reference) on every render, which would
  // defeat the card's React.memo.
  const checkinHistoryInsights = useMemo(() => {
    return (d?.insights ?? EMPTY_ARRAY).filter((i) => {
      if (i.type === 'habit_consistency') return true;
      const nonHealth = new Set(['habits', 'wellbeing']);
      return i.domains?.every((dom: string) => nonHealth.has(dom)) ?? false;
    });
  }, [d?.insights]);

  // The ONE canonical VO2 max fact — the server's 'fitness' health insight
  // (intelligence/recovery.js's fitnessFinding, the SAME authority "What The
  // Data Shows" renders) — passed to HealthCard so its hero number can never
  // silently disagree with the insights card (the "46.3 vs 46.6" production
  // bug: the Health screen used to compute its own value straight off
  // on-device HealthKit, independent of this server fact).
  const vo2Fact = useMemo(() => {
    const f = d?.healthInsights?.find((i) => i.type === 'fitness');
    const current = f?.evidence?.current;
    if (typeof current !== 'number') return null;
    const asOf = f?.evidence?.asOf;
    return { value: current, asOf: typeof asOf === 'string' ? asOf : null };
  }, [d?.healthInsights]);

  // Today command-center's risk/sinceMorning/previews — ONE safe accessor
  // (src/lib/todayCommandCenter.ts) rather than three separate inline
  // `d?.todayCommandCenter?.x ?? y` expressions, so an older cached payload
  // missing this field degrades identically everywhere it's read.
  const todayCC = useMemo(() => selectTodayCommandCenter(d), [d]);

  // The quick-ask FAB reads this every render (it's a prop on AskOverlay) —
  // memoize so it isn't a fresh array each time only the recovery score's
  // digits are unchanged but something unrelated re-rendered App.
  const askContextStarters = useMemo(
    () => contextStartersFor(tab, {
      score: liveRecovery.recovery?.score,
      band: liveRecovery.recovery?.band,
      risk: d?.chiefBrief?.risk,
    }),
    [tab, liveRecovery.recovery?.score, liveRecovery.recovery?.band, d?.chiefBrief?.risk]
  );

  // Subtitle under the tab title — shows briefing age on non-Health tabs, and
  // last-refreshed time on Health so the user knows the refresh actually worked.
  const tabSubtitle = useMemo(() => {
    if (tab === 'health') {
      if (!health.lastFetched) return null;
      return `Refreshed at ${health.lastFetched.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    }
    if (briefing.rebuilding) return 'Rebuilding... usually 60–90s';
    // Age the tab off snapshotAt (when the STATE was cut), not builtAt (which
    // advances on a text-only Chief Brief rebuild too) — otherwise a scoped
    // rebuild would reset every tab to "Built just now" though its data is
    // unchanged. Fall back to builtAt for briefs saved before snapshotAt existed.
    const stateAt = d?.snapshotAt ?? d?.builtAt;
    if (!stateAt) return d?.stale ? 'Briefing is stale' : null;
    const ageMs = Date.now() - new Date(stateAt).getTime();
    const ageMin = Math.floor(ageMs / 60000);
    let label: string;
    if (ageMin < 2) label = 'Built just now';
    else if (ageMin < 60) label = `Built ${ageMin}m ago`;
    else {
      const ageH = Math.floor(ageMin / 60);
      label = ageH < 24 ? `Built ${ageH}h ago` : `Built ${Math.floor(ageH / 24)}d ago`;
    }
    return label;
  }, [tab, health.lastFetched, d?.snapshotAt, d?.builtAt, d?.stale, briefing.rebuilding]);

  const renderTab = () => {
    switch (tab) {
      case 'health': {
        // Health tab redesign (audit rec #4) — a compact landing page
        // answering "what state am I in / what should I train / is it
        // reliable / what's worth noticing" in under five seconds, with
        // detailed execution (Training), evidence depth (Patterns &
        // experiments), and history (Health history) one tap away as
        // full-screen drill-ins rather than an endless stacked scroll.
        // `liveRecovery` is the SAME canonical authority the old landing page
        // used; `d.effectiveWorkout` is backend getEffectiveWorkout()'s own
        // shape (routes/briefing.js), never re-derived on the client.
        const currentRecovery = liveRecovery.fetched ? liveRecovery.recovery : (liveRecovery.recovery ?? d?.recovery);
        return (
          <>
            <SleepCheckInCard visible={liveRecovery.needsSleepCheckIn} onSubmitted={onSleepLogged} />
            <HealthStateCard
              recovery={currentRecovery}
              effectiveWorkout={d?.effectiveWorkout}
              highlight={radarAnchor?.entityType === 'recovery'}
              onHighlightLayout={onRadarAnchorLayout}
            />
            {/* Graduated from the buried Health history drill-in: HRV, resting
                HR, sleep, steps, active calories, and VO2 max — right under
                the recovery hero so the actual vitals behind "Ready"/"Recover"
                are visible without a second tap. */}
            <HealthCard health={health} canonicalVo2={vo2Fact} />
            <TrainingSummaryCard
              effectiveWorkout={d?.effectiveWorkout}
              refreshKey={trainingRefreshGen}
              onOpenTraining={() => setTrainingOpen(true)}
              onSwap={() => setTrainingOpen(true)}
              onLogDifferent={() => setTrainingOpen(true)}
            />
            <WorthKnowingCard insights={d?.healthInsights ?? EMPTY_ARRAY} />

            <View style={styles.healthDrillInRow}>
              <TouchableOpacity onPress={() => setPatternsOpen(true)} style={[styles.drillInBtn, { backgroundColor: c.card }, shadow(isDark)]} activeOpacity={0.7}>
                <Text style={[styles.drillInText, { color: c.text }]}>Patterns & experiments</Text>
                <Text style={[styles.drillInChevron, { color: c.subtext }]}>›</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setHistoryOpen(true)} style={[styles.drillInBtn, { backgroundColor: c.card }, shadow(isDark)]} activeOpacity={0.7}>
                <Text style={[styles.drillInText, { color: c.text }]}>Health history</Text>
                <Text style={[styles.drillInChevron, { color: c.subtext }]}>›</Text>
              </TouchableOpacity>
            </View>

            <TrainingScreen
              visible={trainingOpen}
              onClose={() => {
                setTrainingOpen(false);
                briefing.reload();
                setTrainingRefreshGen((g) => g + 1);
              }}
              hrv={health.hrv}
              isDark={isDark}
              recoveryBand={liveRecovery.recovery?.band ?? null}
              recoveryScore={liveRecovery.recovery?.score ?? null}
            />
            <PatternsExperimentsScreen visible={patternsOpen} onClose={() => setPatternsOpen(false)} />
            <HealthHistoryScreen
              visible={historyOpen}
              onClose={() => setHistoryOpen(false)}
              recovery={currentRecovery}
              composites={d?.healthComposites ?? EMPTY_ARRAY}
              recoveryBuiltAt={liveRecovery.fetched ? undefined : (d?.fieldsBuiltAt?.recovery ?? d?.snapshotAt ?? d?.builtAt)}
              todayForecast={d?.todayForecast}
              forecasts={d?.forecasts ?? EMPTY_ARRAY}
              checkinHistoryInsights={checkinHistoryInsights}
            />
          </>
        );
      }
      case 'wealth': {
        if (!d && briefing.loading) {
          return (<><SkeletonCard tall rows={4} /><SkeletonCard rows={5} /></>);
        }
        // Wealth redesign (audit rec #5): one dominant posture card, at most
        // three ranked developments, one recommended action (or an explicit
        // "no action needed"), then a compact Explore entry point for
        // secondary reporting — NOT a miniature financial-reporting app.
        // Every number comes from d.wealthLanding, the ONE canonical
        // projection (backend/src/services/wealth-landing.js); nothing here
        // recomputes spending/savings-rate/pace/net-worth-direction.
        const landing = d?.wealthLanding ?? null;
        // The disconnected CTA must come ONLY from the canonical source-
        // health authority (landing.sourceHealth.configured), never be
        // inferred from "no landing yet" — that inference is exactly what
        // caused a connected Monarch to briefly flash "Connect Monarch"
        // while the first real response was still loading. A landing with
        // configured:false really is disconnected; a null landing while the
        // very first fetch is in flight is not — that's the skeleton case
        // above, or (after briefingMerge.ts's protection) simply never
        // happens once a good response has ever been seen this session.
        const sourceDisconnected = landing != null && landing.sourceHealth.configured === false;
        const neverLoaded = !landing && !briefing.loading;
        const askAboutFinances = (question: string) => { setPendingAskQ(question); setTab('ask'); };
        return (
          <>
            {d?.wealthLandingStale ? (
              <Text style={[styles.wealthStaleNote, { color: c.subtext }]}>Showing last known data — updating…</Text>
            ) : null}
            <WealthPostureCard
              landing={landing}
              onViewExceptions={landing?.whatChanged?.length ? () => setRadarAnchor({ entityType: 'wealthInsight', entityId: null }) : undefined}
            />
            <WealthWhatChangedCard
              items={landing?.whatChanged ?? EMPTY_ARRAY}
              onChanged={() => briefing.reload()}
              highlight={radarAnchor?.entityType === 'wealthInsight'}
              onHighlightLayout={onRadarAnchorLayout}
            />
            <WealthActionCard
              action={landing?.recommendedAction ?? null}
              dataIncomplete={landing?.severity === 'unavailable'}
              onAsk={askAboutFinances}
              onChanged={() => briefing.reload()}
            />
            <View style={styles.healthDrillInRow}>
              <TouchableOpacity onPress={() => setWealthExploreOpen(true)} style={[styles.drillInBtn, { backgroundColor: c.card }, shadow(isDark)]} activeOpacity={0.7}>
                <Text style={[styles.drillInText, { color: c.text }]}>Explore</Text>
                <Text style={[styles.drillInChevron, { color: c.subtext }]}>›</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => askAboutFinances('Walk me through my wealth dashboard and financial plan')} style={[styles.drillInBtn, { backgroundColor: c.card }, shadow(isDark)]} activeOpacity={0.7}>
                <Text style={[styles.drillInText, { color: c.text }]}>Ask about my finances</Text>
                <Text style={[styles.drillInChevron, { color: c.subtext }]}>›</Text>
              </TouchableOpacity>
            </View>
            <WealthExploreScreen visible={wealthExploreOpen} onClose={() => setWealthExploreOpen(false)} landing={landing} />
            {(sourceDisconnected || neverLoaded) && (
              <EmptyNote c={c} text="Connect Monarch to see net worth, spending, and cashflow." />
            )}
          </>
        );
      }
      case 'wisdom':
        if (!d && briefing.loading) {
          return (<><SkeletonCard tall rows={3} /><SkeletonCard rows={4} /></>);
        }
        return (
          <>
            <WisdomListenCard
              hasContent={Boolean(
                (d?.quote && d?.quoteInsight) || (d?.notionQuote && d?.notionInsight) || d?.relevantHighlight?.content
              )}
              snapshotId={d?.snapshotId}
              stale={Boolean(d?.localDate) && d?.localDate !== todayLocalDate}
            />
            {d?.quote && d?.quoteInsight && <QuoteCard quote={d.quote} insight={d.quoteInsight} />}
            {d?.notionText && d?.notionInsight && (
              <NotionCard pageTitle={d?.notionPageTitle ?? ''} notionText={d.notionText} quote={d?.notionQuote} insight={d.notionInsight} />
            )}
            {/* Semantically matched highlight — surfaced based on your wellbeing patterns */}
            <LibraryCard highlight={d?.relevantHighlight ?? null} wellbeingTheme={d?.wellbeingTheme} />
            <HighlightsCard />
          </>
        );
      case 'ask':
        return null; // rendered outside the ScrollView below
      case 'today':
      default:
        // Cold load (no cached briefing yet): show a skeleton feed so the layout
        // is reserved and nothing pops in / reflows. Warm opens have cached data
        // and skip straight to content.
        if (!d && briefing.loading) {
          return (
            <>
              <SkeletonCard tall rows={5} />
              <SkeletonCard rows={3} />
              <SkeletonCard rows={3} />
            </>
          );
        }
        return (
          <>
            {/* Today command-center ordering (redesign): NOW + the single
                ACTION (+ RISK, only when server-gated evidence exists) must
                be understandable in ~30 seconds, at or near the top of the
                fold — everything else is progressive disclosure or a link
                out to its authoritative domain tab. See
                brain/todayCommandCenter.js for the projection this renders;
                mobile never recomputes risk, resolves the workout, or
                decides what's important on its own. */}

            {/* Sleep check-in — only when there's no Pod reading to fill the
                gap. Leads when present so logging sleep is the first action. */}
            <SleepCheckInCard visible={liveRecovery.needsSleepCheckIn} onSubmitted={onSleepLogged} />
            {/* Evening wind-down brief — leads in the evening (self-hides
                during the day and when no brief is built) and already
                implements the "plan vs. actual, not the morning action
                treated as unfinished" adaptive requirement on its own
                (notify/evening-brief.js's canonical trainingOutcome-based
                grading) — reused as-is, not rebuilt. */}
            {eveningBrief.brief && (
              // Opacity-only (distance 0): the evening brief loads async and inserts
              // at the top, so a slide would compound with the layout shift and read
              // as a shake. A clean fade-in-place is smooth. (Morning brief keeps its
              // slide/cascade — it's present from cached data, so no async glitch.)
              <AnimatedEntry delay={0} distance={0}>
                <EveningBriefCard brief={eveningBrief.brief} />
              </AnimatedEntry>
            )}
            {/* PLAN CONFLICT (Part 1) — the day's plan disagreeing with
                itself takes priority over everything below it; resolving it
                IS the single best next action when it's present, so it
                renders above NOW/ACTION rather than competing with them. */}
            {todayCC.planConflict && (
              <AnimatedEntry delay={0}>
                <PlanConflictCard conflict={todayCC.planConflict} onResolve={resolvePlanConflict} />
              </AnimatedEntry>
            )}
            {/* NOW + ACTION (+ RISK) — the one thing, leads the day. On
                sessions that START in the evening (wind-down brief already
                live), the day is over and this is yesterday-morning news: it
                steps back into a collapsed recap so the evening card owns
                the screen. Latched per session (see eveningMode) so it never
                swaps subtrees mid-use. */}
            {eveningMode ? (
              <AnimatedEntry delay={10}>
                <CollapsibleSection title="This morning's brief">
                  <BriefCard
                    brief={d?.chiefBrief}
                    fallback={d?.morningFocus}
                    stale={d?.chiefBriefStale}
                    pending={d?.chiefBriefPending}
                    quality={d?.chiefBriefQuality}
                    goalsStale={d?.chiefBriefGoalsStale}
                    onRefresh={briefing.refreshChiefBrief}
                    refreshing={briefing.chiefBriefRefreshing}
                    snapshotId={d?.snapshotId}
                    risk={todayCC.risk}
                    error={Boolean(briefing.error)}
                    buildState={briefing.buildState}
                    buildFailure={briefing.buildFailure}
                  />
                </CollapsibleSection>
              </AnimatedEntry>
            ) : (
              <AnimatedEntry delay={0}>
                <BriefCard
                  brief={d?.chiefBrief}
                  fallback={d?.morningFocus}
                  stale={d?.chiefBriefStale}
                  pending={d?.chiefBriefPending}
                  quality={d?.chiefBriefQuality}
                  goalsStale={d?.chiefBriefGoalsStale}
                  onRefresh={briefing.refreshChiefBrief}
                  refreshing={briefing.chiefBriefRefreshing}
                  snapshotId={d?.snapshotId}
                  risk={todayCC.risk}
                  error={Boolean(briefing.error)}
                  buildState={briefing.buildState}
                  buildFailure={briefing.buildFailure}
                />
              </AnimatedEntry>
            )}
            {/* COMMITMENTS — what you explicitly agreed to do today. Self-
                hides when nothing is outstanding. */}
            {commitments.commitments.length > 0 && (
              <AnimatedEntry delay={10}>
                <CommitmentsCard commitments={commitments.commitments} onResolve={commitments.resolve} />
              </AnimatedEntry>
            )}
            {/* Alerts — operational/source-health warnings ("something
                broke"), kept visually distinct from a personal insight. */}
            {d?.alerts && d.alerts.length > 0 && (
              <AnimatedEntry delay={20}>
                <AlertCard alerts={d.alerts} />
              </AnimatedEntry>
            )}
            {/* SINCE THIS MORNING — only genuine post-snapshot changes (see
                todayCommandCenter.sinceMorning); self-hides when empty. */}
            <AnimatedEntry delay={30}>
              <SinceMorningCard
                items={todayCC.sinceMorning}
                onNavigate={navigateFromToday}
              />
            </AnimatedEntry>
            {/* ON MY RADAR — server-ranked, full-width (Today redesign Part
                3): 0-2 cards normally, never a guaranteed per-domain slot
                (see todayCommandCenter.radar / brain/radar.js). Tapping opens
                the full detail sheet below; the section itself never
                self-hides — it shows the truthful quiet line instead of an
                empty grid when nothing deserves attention. */}
            <AnimatedEntry delay={35}>
              <RadarSection radar={todayCC.radar} onOpen={openRadarCard} />
            </AnimatedEntry>
            {d?.crossContextInsights && d.crossContextInsights.length > 0 && (
              <AnimatedEntry delay={40}>
                <CrossContextCard insights={d.crossContextInsights.slice(0, 1)} />
              </AnimatedEntry>
            )}
            {/* Streak / trend signals (one-question prompts) — kept as its
                own small interactive card, positioned low (not competing
                with NOW/ACTION for visual weight). */}
            {d?.signals && d.signals.length > 0 && (
              <AnimatedEntry delay={50}>
                <BriefSignalsCard signals={d.signals} />
              </AnimatedEntry>
            )}
            {weeklyReviewOpen && (
              <WeeklyReviewModal
                visible={weeklyReviewOpen}
                onClose={closeWeeklyReview}
                review={weeklyReviewOverride ?? d?.weeklyReview ?? null}
                loading={weeklyReviewLoading}
                error={weeklyReviewError}
                onRetry={retryWeeklyReview}
              />
            )}
            <RadarDetailSheet
              card={radarDetailCard}
              onClose={closeRadarDetail}
              onOpenDestination={openRadarDestination}
              onDismiss={dismissRadarCard}
              bottomInset={bottomInset}
            />
            {briefing.error && !d && (
              <AnimatedEntry delay={0}>
                <View style={[styles.errorBox, { backgroundColor: c.card }, shadow(isDark)]}>
                  <Text style={[styles.errorTitle, { color: c.text }]}>Cannot reach backend</Text>
                  <Text style={[styles.errorMsg, { color: c.subtext }]}>
                    Make sure the backend is running:{'\n'}cd backend && node server.js
                  </Text>
                  <Text style={[styles.errorDetail, { color: c.subtext }]}>{briefing.error}</Text>
                </View>
              </AnimatedEntry>
            )}
            {briefing.loading && !d && (
              <AnimatedEntry delay={0}>
                <View style={styles.loadingBlock}>
                  <ActivityIndicator color={c.subtext} />
                  <Text style={[styles.loadingText, { color: c.subtext }]}>Generating your briefing…</Text>
                </View>
              </AnimatedEntry>
            )}
          </>
        );
    }
  };

  if (!fontsLoaded || !themeReady) return null; // wait for custom fonts + theme pref before first paint
  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      {/* Signature hero aurora — a soft band-tinted glow rendered at the ROOT so it
          bleeds up behind the status bar / notch curve (not just below the safe-area
          inset), fading into the page. Sits behind all content; the transparent
          ScrollView lets it show through the top. */}
      {tab !== 'ask' && (() => {
        // The band tint means "today's body state" — it belongs on the health
        // surfaces (Today, Health). On Wealth/Wisdom it would be an arbitrary green
        // wash, so those get a neutral brand tint instead (keeps the top-of-screen
        // color coverage without implying a recovery signal where there isn't one).
        const healthTab = tab === 'today' || tab === 'health';
        const b = liveRecovery.recovery?.band;
        const hero: [string, string] = !healthTab
          ? ['rgba(99,91,255,0.10)', 'rgba(99,91,255,0)']
          : b === 'green' ? ['rgba(90,232,154,0.22)', 'rgba(90,232,154,0)']
          : b === 'yellow' ? ['rgba(255,196,77,0.22)', 'rgba(255,196,77,0)']
          : b === 'red' ? ['rgba(255,132,120,0.20)', 'rgba(255,132,120,0)']
          : ['rgba(99,91,255,0.14)', 'rgba(99,91,255,0)'];
        return (
          <LinearGradient
            colors={hero}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={styles.heroGlow}
            pointerEvents="none"
          />
        );
      })()}
      <SafeAreaView style={styles.safe}>
        {tab === 'ask' ? (
          <AskOverlay
            embedded
            initialQuestion={pendingAskQ}
            bottomInset={bottomInset}
            activeTab="ask"
            snapshotId={d?.snapshotId ?? null}
            snapshotVersion={d?.snapshotVersion ?? null}
            onVoiceActionExecuted={() => { briefing.reload(); health.refetch(); }}
          />
        ) : (
          <ScrollView
            ref={scrollRef}
            style={styles.scroll}
            contentContainerStyle={styles.content}
            refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={c.subtext} />}
            showsVerticalScrollIndicator={false}
            onScroll={onScrollTrackToday}
            scrollEventThrottle={16}
            // Cards embedded here (WeeklyIntentionsCard's goal/context inputs,
            // BriefCard's alternate-action freeform box, etc.) sit at arbitrary
            // scroll positions, not pinned to the bottom like AskOverlay/
            // TalkOverlay's chat input — so a fixed bottom-padding trick doesn't
            // bring a focused field into view, only a real "scroll to it" does.
            // This RN 0.71+ prop does exactly that on iOS.
            automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
          >
            <Header date={d?.date ?? today} />
            <AnimatedEntry key={tab} delay={0} distance={6} style={styles.titleRow}>
              <View>
                <Text style={[styles.tabTitle, { color: c.text }]}>{tabTitle}</Text>
                {tabSubtitle && (
                  <Text style={[styles.builtAt, { color: c.subtext }]}>{tabSubtitle}</Text>
                )}
              </View>
              {tab === 'today' ? (
                <View style={styles.todayActions}>
                  <TouchableOpacity
                    onPress={() => setCheckinOpen(true)}
                    style={[styles.tabRefreshBtn, { borderColor: c.border, backgroundColor: c.card }]}
                  >
                    <Text style={[styles.tabRefreshTxt, { color: c.accent }]}>✓ Check in</Text>
                    {!dailyLog.checkinLogged && (
                      <View style={[styles.badge, { backgroundColor: c.accent, borderColor: c.background }]} />
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setHabitsOpen(true)}
                    style={[styles.tabRefreshBtn, { borderColor: c.border, backgroundColor: c.card }]}
                  >
                    <Text style={[styles.tabRefreshTxt, { color: c.accent }]}>🔁 Habits</Text>
                    {!dailyLog.habitsLogged && (
                      <View style={[styles.badge, { backgroundColor: c.accent, borderColor: c.background }]} />
                    )}
                  </TouchableOpacity>
                </View>
              ) : tabRefresh[tab] ? (
                <TouchableOpacity
                  onPress={tabRefresh[tab]!.run}
                  disabled={tabRefresh[tab]!.busy}
                  style={[styles.tabRefreshBtn, { borderColor: c.border, backgroundColor: c.card }]}
                >
                  {tabRefresh[tab]!.busy ? (
                    <ActivityIndicator size="small" color={c.subtext} />
                  ) : (
                    <Text style={[styles.tabRefreshTxt, { color: c.accent }]}>
                      ↻ {tabRefresh[tab]!.label}
                    </Text>
                  )}
                </TouchableOpacity>
              ) : null}
            </AnimatedEntry>
            {renderTab()}
            <View style={styles.footer} />
          </ScrollView>
        )}
      </SafeAreaView>

      <CheckinModal
        visible={checkinOpen}
        onClose={() => { setCheckinOpen(false); dailyLog.refresh(); }}
      />
      <HabitsModal
        visible={habitsOpen}
        onClose={() => { setHabitsOpen(false); dailyLog.refresh(); }}
      />
      {/* Quick Ask — summoned by long-pressing the Ask tab, or by the mic FAB
          (shown on every tab except Ask itself, which already has the input
          row front and center). Both open the same sheet, seeded with the
          same context-aware starters. */}
      <AskOverlay
        ref={quickAskRef}
        hideFab={tab === 'ask'}
        contextStarters={askContextStarters}
        bottomInset={bottomInset}
        activeTab={tab === 'today' || tab === 'health' || tab === 'wealth' || tab === 'wisdom' ? tab : 'ask'}
        snapshotId={d?.snapshotId ?? null}
        snapshotVersion={d?.snapshotVersion ?? null}
        // A bare tab-level default selection: being on Health with no more
        // specific tap yet is still enough context for "why is this
        // yellow?" to resolve against today's recovery (chat/voiceContext.js
        // resolves 'recovery'/'today' the same way regardless of who asked
        // for it). Per-card tap-to-select (a specific commitment/insight)
        // is documented as follow-up work — see the task's final report.
        voiceSelection={tab === 'health' ? { kind: 'recovery', id: 'today' } : null}
        onVoiceActionExecuted={() => { briefing.reload(); health.refetch(); }}
      />
      <TabBar
        active={tab}
        onChange={(key) => {
          if (tab === 'ask' && key !== 'ask') setPendingAskQ('');
          // Landing on Today: re-pull commitments so a reminder just set by
          // voice (from the Ask tab) shows up without waiting for a foreground cycle.
          if (key === 'today' && tab !== 'today') commitments.refetch();
          setTab(key);
        }}
        bottomInset={bottomInset}
        healthDot={
          liveRecovery.recovery?.band === 'green' ? c.green
            : liveRecovery.recovery?.band === 'yellow' ? c.yellow
            : liveRecovery.recovery?.band === 'red' ? c.red
            : null
        }
        onLongPress={(key) => {
          if (key === 'ask' && tab !== 'ask') {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            quickAskRef.current?.openWith(undefined, contextStartersFor(tab, {
              score: liveRecovery.recovery?.score,
              band: liveRecovery.recovery?.band,
              risk: d?.chiefBrief?.risk,
            }));
          }
        }}
      />

      {/* Cold-open welcome overlay — covers the feed assembly, then slow-dissolves
          into a fully-settled Today tab. Last child + zIndex so it's on top. */}
      {showWelcome && (
        <WelcomeScreen ready={!!d && eveningBrief.fetched} onDone={() => setShowWelcome(false)} />
      )}
    </View>
  );
}

function EmptyNote({ c, text }: { c: ReturnType<typeof getColors>; text: string }) {
  const isDark = useColorScheme() === 'dark';
  return (
    <View style={[styles.empty, { backgroundColor: c.card }, shadow(isDark)]}>
      <Text style={[styles.emptyText, { color: c.subtext }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  safe: { flex: 1 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: spacing.md, paddingBottom: spacing.xl },
  // Health tab redesign (audit rec #4) — the two focused-destination entry
  // points below Worth Knowing.
  healthDrillInRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  drillInBtn: {
    flex: 1, borderRadius: radius.md, padding: spacing.sm + 2,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  drillInText: { fontSize: 13, fontWeight: '600' },
  drillInChevron: { fontSize: 16, fontWeight: '300' },
  wealthStaleNote: { fontSize: 12, fontStyle: 'italic', marginBottom: spacing.sm },
  // Anchored to the very top edge (y=0, behind the status bar) and full-bleed, so
  // the band tint covers the notch curve and fades down into the page.
  heroGlow: { position: 'absolute', top: 0, left: 0, right: 0, height: 440 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
    marginTop: spacing.xs,
  },
  tabTitle: {
    fontFamily: FONTS.display,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  builtAt: { fontSize: 11, marginTop: 1 },
  todayActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  tabRefreshBtn: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 6,
    minWidth: 60,
    alignItems: 'center',
  },
  tabRefreshTxt: { fontSize: 12, fontWeight: '600' },
  badge: {
    position: 'absolute',
    top: -3,
    right: -3,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
  },
  errorBox: { borderRadius: 12, padding: spacing.md, marginBottom: spacing.md },
  errorTitle: { fontSize: 16, fontWeight: '600', marginBottom: spacing.xs },
  errorMsg: { fontSize: 14, lineHeight: 21, marginBottom: spacing.sm },
  errorDetail: { fontSize: 12, fontStyle: 'italic' },
  loadingBlock: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.md },
  loadingText: { fontSize: 14, fontStyle: 'italic' },
  empty: { borderRadius: 14, padding: spacing.lg, marginBottom: spacing.md },
  emptyText: { fontSize: 14, lineHeight: 21, fontStyle: 'italic' },
  // Clears the floating Ask mic FAB (AskOverlay's fabWrap: position:absolute,
  // bottom: bottomInset+70, 52pt tall — so its top edge sits ~59-67pt above
  // the TabBar's top edge, which is where the scrollable area ends). The
  // prior height (spacing.lg=24, +content's paddingBottom=32 => 56pt total)
  // left the last scrolled item's bottom edge a few points BEHIND the FAB —
  // most visible when a quiet/empty-state row (e.g. RadarSection's "Everything
  // else looks on track") is the last thing on screen, since it has little
  // visual weight of its own to make the clipping obvious as anything but a
  // real bug. This is a general scroll-clearance fix, not a RadarSection-only
  // patch, since ANY tab's last item can land in the same spot.
  footer: { height: spacing.xxl + spacing.md },
});
