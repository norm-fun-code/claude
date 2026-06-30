import React, { useCallback, useMemo, useState } from 'react';
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
  Appearance,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { AnimatedEntry } from './src/components/AnimatedEntry';

// NormOS is always light (off-white) — easier to read; ignore system dark mode.
Appearance.setColorScheme('light');

import { useBriefing } from './src/hooks/useBriefing';
import { useEveningBrief } from './src/hooks/useEveningBrief';
import { useHealthData } from './src/hooks/useHealthData';
import { useRecovery } from './src/hooks/useRecovery';
import { usePushRegistration } from './src/hooks/usePushRegistration';
import { getColors, spacing, shadow, FONTS } from './src/theme';

import { Header } from './src/components/Header';
import { TabBar, TabKey, TABS } from './src/components/TabBar';
import { ForecastCard } from './src/components/ForecastCard';
import { WealthCard } from './src/components/WealthCard';
import { AssetMixCard } from './src/components/AssetMixCard';
import { InsightsCard } from './src/components/InsightsCard';
import { AskOverlay } from './src/components/AskOverlay';
import { CheckinModal } from './src/components/CheckinModal';
import { WeeklyIntentionsCard } from './src/components/WeeklyIntentionsCard';
import { HealthCard } from './src/components/HealthCard';
import { LinearGradient } from 'expo-linear-gradient';
import { RecoveryCard } from './src/components/RecoveryCard';
import { SleepCheckInCard } from './src/components/SleepCheckInCard';
import { GradientButton } from './src/components/GradientButton';
import { WorkoutsPanel } from './src/components/WorkoutsPanel';
import { QuoteCard } from './src/components/QuoteCard';
import { NotionCard } from './src/components/NotionCard';
import { AlertCard } from './src/components/AlertCard';
import { HighlightsCard } from './src/components/HighlightsCard';
import { BriefCard } from './src/components/BriefCard';
import { EveningBriefCard } from './src/components/EveningBriefCard';
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
import { IndicesCard } from './src/components/IndicesCard';
import { MarketsCard } from './src/components/MarketsCard';
import { useDailyLogStatus } from './src/hooks/useDailyLogStatus';

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

  const [tab, setTab] = useState<TabKey>('today');
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [habitsOpen, setHabitsOpen] = useState(false);
  const [pendingAskQ, setPendingAskQ] = useState('');
  const dailyLog = useDailyLogStatus();
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
    } else if (type === 'evening_health_brief') {
      setTab('today');
      eveningBrief.refetch();
      health.refetch();
    } else {
      briefing.reload();
      health.refetch();
    }
  }, [briefing, health, eveningBrief]);

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
            <HealthCard health={health} />
            {/* healthInsights is the server-curated top set of health domain findings,
                already scored and ranked. Habit/wellbeing-only findings go to the
                merged CheckinHistoryCard in Today's collapsible. */}
            {(d?.healthInsights?.length ?? 0) > 0 ? (
              <InsightsCard insights={d!.healthInsights!} />
            ) : (
              <EmptyNote c={c} text="Health insights (sleep ↔ HRV ↔ focus patterns) appear once a few days of Apple Health + habit data accumulate. Open the app daily so HealthKit syncs, and log your habits on the Today tab." />
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
              <EmptyNote c={c} text="Connect Monarch (your monthly export) to see net worth, spending, and cashflow here." />
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
              // Opacity-only fade (no translateY): it loads async and inserts at the
              // top, so a slide would compound with the layout shift and read as a
              // shake. A clean fade-in-place is smooth.
              <AnimatedEntry delay={0} distance={0}>
                <EveningBriefCard brief={eveningBrief.brief} />
              </AnimatedEntry>
            )}
            {/* 1. Chief Brief — the one thing, leads */}
            <AnimatedEntry delay={0}>
              <BriefCard brief={d?.chiefBrief} fallback={d?.morningFocus} />
            </AnimatedEntry>
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

  if (!fontsLoaded) return null; // wait for custom fonts before first paint
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
      <TabBar
        active={tab}
        onChange={(key) => {
          if (tab === 'ask' && key !== 'ask') setPendingAskQ('');
          setTab(key);
        }}
        bottomInset={bottomInset}
      />
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
