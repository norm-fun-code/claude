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
import { getColors, spacing, shadow, FONTS } from './src/theme';

import { Header } from './src/components/Header';
import { TabBar, TabKey, TABS } from './src/components/TabBar';
import { ForecastCard } from './src/components/ForecastCard';
import { WealthCard } from './src/components/WealthCard';
import { AssetMixCard } from './src/components/AssetMixCard';
import { InsightsCard } from './src/components/InsightsCard';
import { AskOverlay, type AskOverlayHandle } from './src/components/AskOverlay';
import { CheckinModal } from './src/components/CheckinModal';
import { WeeklyIntentionsCard } from './src/components/WeeklyIntentionsCard';
import { HealthCard } from './src/components/HealthCard';
import { LinearGradient } from 'expo-linear-gradient';
import { RecoveryCard } from './src/components/RecoveryCard';
import { NightContextCard } from './src/components/NightContextCard';
import { SleepCheckInCard } from './src/components/SleepCheckInCard';
import { GradientButton } from './src/components/GradientButton';
import { WorkoutsPanel } from './src/components/WorkoutsPanel';
import { QuoteCard } from './src/components/QuoteCard';
import { NotionCard } from './src/components/NotionCard';
import { AlertCard } from './src/components/AlertCard';
import { HighlightsCard } from './src/components/HighlightsCard';
import { BriefCard } from './src/components/BriefCard';
import { EveningBriefCard } from './src/components/EveningBriefCard';
import { WelcomeScreen } from './src/components/WelcomeScreen';
import { SkeletonCard } from './src/components/viz/Skeleton';
import { BriefSignalsCard } from './src/components/BriefSignalsCard';
import { TodayForecastCard } from './src/components/TodayForecastCard';
import { ExperimentsCard } from './src/components/ExperimentsCard';
import { CrossContextCard } from './src/components/CrossContextCard';
import { CollapsibleSection } from './src/components/CollapsibleSection';
import { SelfModelCard } from './src/components/SelfModelCard';
import { WeeklyStateCard } from './src/components/WeeklyStateCard';
import { CheckinHistoryCard } from './src/components/CheckinHistoryCard';
import { HabitsModal } from './src/components/HabitsModal';
import { LibraryCard } from './src/components/LibraryCard';
import { RecommendationLedgerCard } from './src/components/RecommendationLedgerCard';
import { CommitmentsCard } from './src/components/CommitmentsCard';
import { IndicesCard } from './src/components/IndicesCard';
import { MarketsCard } from './src/components/MarketsCard';
import { useDailyLogStatus } from './src/hooks/useDailyLogStatus';
import { useCommitments } from './src/hooks/useCommitments';

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
  // Snap to top whenever the active tab changes.
  const scrollRef = useRef<ScrollView>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ y: 0, animated: false }); }, [tab]);
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
  // server cache (instant) + the fast recovery endpoint on Health. Nothing
  // here triggers an LLM or a briefing rebuild — that's what each tab's
  // explicit refresh button is for, so you choose what to spend time updating.
  const onRefresh = useCallback(() => {
    health.refetch();
    if (tab === 'health') liveRecovery.refetch();
    else briefing.reload();
  }, [briefing, health, liveRecovery, tab]);

  const d = briefing.data;

  // Per-tab explicit refresh — each tab updates only its own content. Today is
  // handled separately in the title row (icon arrow + check-in button); the rest
  // keep a labeled button:
  //   Wealth → "Rebuild briefing" (non-blocking async rebuild, ~60-90s)
  //   Health → HealthKit + live recovery score (sub-second)
  //   Wisdom → day-locked by design; reloads the morning cache
  const tabRefresh: Partial<Record<TabKey, { label: string; busy: boolean; run: () => void }>> = {
    wealth: { label: 'Rebuild briefing', busy: briefing.rebuilding, run: briefing.triggerRebuild },
    health: {
      label: 'Refresh health data',
      busy: health.loading || liveRecovery.loading,
      run: () => { health.refetch(); liveRecovery.refetch(); },
    },
    wisdom: { label: 'Reload', busy: briefing.loading, run: briefing.reload },
  };

  // Tapping the morning "briefing ready" push should load the cache the server
  // already warmed at 8:30 — instant, not a 15-40s forced rebuild. Health still
  // refreshes from the device.
  const onNotificationTap = useCallback((data: Record<string, unknown>) => {
    const key = typeof data.key === 'string' ? data.key : '';
    const type = typeof data.type === 'string' ? data.type : '';
    if (key.startsWith('habits:')) {
      setHabitsOpen(true);
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
    } else {
      briefing.reload();
      health.refetch();
    }
  }, [briefing, health, eveningBrief, commitments]);

  usePushRegistration(onNotificationTap);

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  const tabTitle = TABS.find((t) => t.key === tab)?.label ?? '';

  // Subtitle under the tab title — shows briefing age on non-Health tabs, and
  // last-refreshed time on Health so the user knows the refresh actually worked.
  const tabSubtitle = useMemo(() => {
    if (tab === 'health') {
      if (!health.lastFetched) return null;
      return `Refreshed at ${health.lastFetched.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    }
    if (briefing.rebuilding) return 'Rebuilding... usually 60–90s';
    if (!d?.builtAt) return d?.stale ? 'Briefing is stale' : null;
    const ageMs = Date.now() - new Date(d.builtAt).getTime();
    const ageMin = Math.floor(ageMs / 60000);
    let label: string;
    if (ageMin < 2) label = 'Built just now';
    else if (ageMin < 60) label = `Built ${ageMin}m ago`;
    else {
      const ageH = Math.floor(ageMin / 60);
      label = ageH < 24 ? `Built ${ageH}h ago` : `Built ${Math.floor(ageH / 24)}d ago`;
    }
    return label;
  }, [tab, health.lastFetched, d?.builtAt, d?.stale, briefing.rebuilding]);

  const renderTab = () => {
    switch (tab) {
      case 'health':
        return (
          <>
            <SleepCheckInCard visible={liveRecovery.needsSleepCheckIn} onSubmitted={() => { liveRecovery.refetch(); briefing.triggerRebuild(); }} />
            <RecoveryCard
              recovery={liveRecovery.fetched ? liveRecovery.recovery : (liveRecovery.recovery ?? d?.recovery)}
              composites={d?.healthComposites ?? []}
              builtAt={liveRecovery.fetched ? undefined : d?.builtAt}
            />
            <NightContextCard />
            <HealthCard health={health} />
            {/* healthInsights is the server-curated top set of health domain findings,
                already scored and ranked. Habit/wellbeing-only findings go to the
                merged CheckinHistoryCard in Today's collapsible. */}
            {(d?.healthInsights?.length ?? 0) > 0 ? (
              <InsightsCard insights={d!.healthInsights!} />
            ) : (
              <EmptyNote c={c} text="Insights appear after a few days of health + habit data." />
            )}
            <WorkoutsPanel hrv={health.hrv} isDark={isDark} recoveryBand={liveRecovery.recovery?.band ?? null} recoveryScore={liveRecovery.recovery?.score ?? null} />
            <ForecastCard forecasts={d?.forecasts ?? []} />
            <CollapsibleSection title="NormOS profile">
              <SelfModelCard />
            </CollapsibleSection>
          </>
        );
      case 'wealth':
        if (!d && briefing.loading) {
          return (<><SkeletonCard tall rows={4} /><SkeletonCard rows={5} /></>);
        }
        return (
          <>
            <GradientButton
              label="Ask about my finances"
              onPress={() => { setPendingAskQ('Walk me through my wealth dashboard and financial plan'); setTab('ask'); }}
              style={styles.wealthAskBtn}
            />
            <WealthCard wealth={d?.wealth ?? null} />
            {/* Asset Mix — structural allocation + single-name concentration,
                sits right under net worth (a natural extension of it). */}
            <AssetMixCard />
            {/* "What the data shows" (personal finance insights) leads; the market
                scoreboard + brief group together below it as market context. */}
            <InsightsCard insights={d?.wealthInsights ?? []} />
            <IndicesCard />
            <MarketsCard markets={d?.markets ?? null} />
            {!d?.wealth && (
              <EmptyNote c={c} text="Connect Monarch to see net worth, spending, and cashflow." />
            )}
          </>
        );
      case 'wisdom':
        if (!d && briefing.loading) {
          return (<><SkeletonCard tall rows={3} /><SkeletonCard rows={4} /></>);
        }
        return (
          <>
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
            {/* TODAY-FIRST ordering: the home tab answers "what's the one thing,
                how am I today, what's urgent, what am I running" before any
                reflective/historical detail. The brief leads, recovery grade and
                urgent flags sit right under it, then today's experiment and the
                cross-domain insight; goal forecasts, trends, weekly review, and the
                ledger drop below the fold. */}

            {/* 0. Sleep check-in — only when there's no Pod reading to fill the gap.
                Leads when present so logging sleep is the first action. */}
            <SleepCheckInCard visible={liveRecovery.needsSleepCheckIn} onSubmitted={() => { liveRecovery.refetch(); briefing.triggerRebuild(); }} />
            {/* 0.5 Evening wind-down brief — leads in the evening (self-hides during
                the day and when no brief is built), so the home tab feels alive at
                night instead of showing a stale morning memo. */}
            {eveningBrief.brief && (
              // Opacity-only (distance 0): the evening brief loads async and inserts
              // at the top, so a slide would compound with the layout shift and read
              // as a shake. A clean fade-in-place is smooth. (Morning brief keeps its
              // slide/cascade — it's present from cached data, so no async glitch.)
              <AnimatedEntry delay={0} distance={0}>
                <EveningBriefCard brief={eveningBrief.brief} />
              </AnimatedEntry>
            )}
            {/* 1. Chief Brief — the one thing, leads the day. On sessions that
                START in the evening (wind-down brief already live), the day is
                over and this is yesterday-morning news: it steps back into a
                collapsed recap so the evening card owns the screen. Latched per
                session (see eveningMode) so it never swaps subtrees mid-use. */}
            {eveningMode ? (
              <AnimatedEntry delay={10}>
                <CollapsibleSection title="This morning's brief">
                  <BriefCard brief={d?.chiefBrief} fallback={d?.morningFocus} stale={d?.chiefBriefStale} />
                </CollapsibleSection>
              </AnimatedEntry>
            ) : (
              <AnimatedEntry delay={0}>
                <BriefCard brief={d?.chiefBrief} fallback={d?.morningFocus} stale={d?.chiefBriefStale} />
              </AnimatedEntry>
            )}
            {/* 1.5 Commitments — what you said you'd do, still open. Sits right
                under the brief because it's the most actionable, time-sensitive
                thing on the screen. Self-hides when nothing is outstanding. */}
            {commitments.commitments.length > 0 && (
              <AnimatedEntry delay={5}>
                <CommitmentsCard commitments={commitments.commitments} onResolve={commitments.resolve} />
              </AnimatedEntry>
            )}
            {/* 2. Recovery grade — "how am I TODAY" is the home-tab question */}
            <AnimatedEntry delay={10}>
              <TodayForecastCard forecast={d?.todayForecast} />
            </AnimatedEntry>
            {/* 3. Alerts / highest-leverage flags — anything urgent today */}
            {d?.alerts && d.alerts.length > 0 && (
              <AnimatedEntry delay={20}>
                <AlertCard alerts={d.alerts} />
              </AnimatedEntry>
            )}
            {/* 4. Experiments — what I'm actively running */}
            <AnimatedEntry delay={30}>
              <ExperimentsCard />
            </AnimatedEntry>
            {/* 5. Cross-domain patterns — the differentiating insight */}
            {d?.crossContextInsights && d.crossContextInsights.length > 0 && (
              <AnimatedEntry delay={45}>
                <CrossContextCard insights={d.crossContextInsights} />
              </AnimatedEntry>
            )}
            {/* 6. Goal forecasts — trajectory, not a daily action → below the fold */}
            {(d?.forecasts ?? []).length > 0 && (
              <AnimatedEntry delay={60}>
                <ForecastCard forecasts={d!.forecasts} />
              </AnimatedEntry>
            )}
            {/* 7. Streak / trend signals (one-question prompts) */}
            {d?.signals && d.signals.length > 0 && (
              <AnimatedEntry delay={75}>
                <BriefSignalsCard signals={d.signals} />
              </AnimatedEntry>
            )}
            {/* 8. Check-in trends + habit streaks — reference detail */}
            <AnimatedEntry delay={90}>
              <CheckinHistoryCard insights={(d?.insights ?? []).filter((i) => {
                if (i.type === 'habit_consistency') return true;
                const nonHealth = new Set(['habits', 'wellbeing']);
                return i.domains?.every((dom: string) => nonHealth.has(dom)) ?? false;
              })} />
            </AnimatedEntry>
            {/* 9. Weekly review + intentions */}
            <AnimatedEntry delay={110}>
              <WeeklyIntentionsCard review={d?.weeklyReview ?? null} actions={d?.leverageActions ?? []} />
            </AnimatedEntry>
            {/* 10. Recommendation ledger — what was recommended and did it work */}
            <AnimatedEntry delay={130}>
              <RecommendationLedgerCard />
            </AnimatedEntry>
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
          />
        ) : (
          <ScrollView
            ref={scrollRef}
            style={styles.scroll}
            contentContainerStyle={styles.content}
            refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={c.subtext} />}
            showsVerticalScrollIndicator={false}
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
                  <TouchableOpacity
                    onPress={briefing.triggerRebuild}
                    disabled={briefing.rebuilding}
                    style={[styles.iconBtn, { borderColor: c.border, backgroundColor: c.card }]}
                    accessibilityLabel="Rebuild briefing"
                  >
                    {briefing.rebuilding ? (
                      <ActivityIndicator size="small" color={c.subtext} />
                    ) : (
                      <Text style={[styles.iconBtnTxt, { color: c.accent }]}>↻</Text>
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
        contextStarters={contextStartersFor(tab, {
          score: liveRecovery.recovery?.score,
          band: liveRecovery.recovery?.band,
          risk: d?.chiefBrief?.risk,
        })}
        bottomInset={bottomInset}
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
  iconBtn: {
    borderWidth: 1,
    borderRadius: 16,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnTxt: { fontSize: 16, fontWeight: '700' },
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
  footer: { height: spacing.lg },
  wealthAskBtn: {
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
});
