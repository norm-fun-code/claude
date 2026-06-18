import React, { useCallback, useMemo, useState } from 'react';
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
import { useHealthData } from './src/hooks/useHealthData';
import { useRecovery } from './src/hooks/useRecovery';
import { usePushRegistration } from './src/hooks/usePushRegistration';
import { getColors, spacing, shadow } from './src/theme';

import { Header } from './src/components/Header';
import { TabBar, TabKey, TABS } from './src/components/TabBar';
import { ForecastCard } from './src/components/ForecastCard';
import { LibraryCard } from './src/components/LibraryCard';
import { WealthCard } from './src/components/WealthCard';
import { InsightsCard } from './src/components/InsightsCard';
import { AskOverlay } from './src/components/AskOverlay';
import { CheckinModal } from './src/components/CheckinModal';
import { WeeklyIntentionsCard } from './src/components/WeeklyIntentionsCard';
import { HealthCard } from './src/components/HealthCard';
import { RecoveryCard } from './src/components/RecoveryCard';
import { WorkoutsPanel } from './src/components/WorkoutsPanel';
import { QuoteCard } from './src/components/QuoteCard';
import { NotionCard } from './src/components/NotionCard';
import { AlertCard } from './src/components/AlertCard';
import { HighlightsCard } from './src/components/HighlightsCard';
import { MorningFocusCard } from './src/components/MorningFocusCard';
import { BriefCard } from './src/components/BriefCard';
import { BriefSignalsCard } from './src/components/BriefSignalsCard';
import { TodayForecastCard } from './src/components/TodayForecastCard';
import { CollapsibleSection } from './src/components/CollapsibleSection';
import { ExperimentsCard } from './src/components/ExperimentsCard';
import { CrossContextCard } from './src/components/CrossContextCard';
import { SelfModelCard } from './src/components/SelfModelCard';
import { SleepLogCard } from './src/components/SleepLogCard';
import { WeeklyStateCard } from './src/components/WeeklyStateCard';
import { CheckinHistoryCard } from './src/components/CheckinHistoryCard';
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
  const health = useHealthData();
  const liveRecovery = useRecovery();

  const [tab, setTab] = useState<TabKey>('today');
  const [checkinOpen, setCheckinOpen] = useState(false);
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
  const onNotificationTap = useCallback(() => {
    briefing.reload();
    health.refetch();
  }, [briefing, health]);

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
            <RecoveryCard
              recovery={liveRecovery.recovery ?? d?.recovery}
              composites={d?.healthComposites ?? []}
              builtAt={liveRecovery.recovery ? undefined : d?.builtAt}
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
            <ExperimentsCard />
            <WorkoutsPanel hrv={health.hrv} isDark={isDark} recoveryBand={liveRecovery.recovery?.band ?? null} recoveryScore={liveRecovery.recovery?.score ?? null} />
            <ForecastCard forecasts={d?.forecasts ?? []} />
          </>
        );
      case 'wealth':
        return (
          <>
            <WealthCard wealth={d?.wealth ?? null} />
            <InsightsCard insights={d?.wealthInsights ?? []} />
            {!d?.wealth && (
              <EmptyNote c={c} text="Connect Monarch (your monthly export) to see net worth, spending, and cashflow here." />
            )}
          </>
        );
      case 'wisdom':
        return (
          <>
            {(d?.quote || d?.quoteInsight) && <QuoteCard quote={d!.quote} insight={d!.quoteInsight} />}
            {(d?.notionText || d?.notionInsight) && (
              <NotionCard pageTitle={d?.notionPageTitle ?? ''} notionText={d!.notionText} quote={d?.notionQuote} insight={d!.notionInsight} />
            )}
            <HighlightsCard />
          </>
        );
      case 'today':
      default:
        return (
          <>
            {/* Chief Brief first — the narrative leads */}
            <AnimatedEntry delay={0}>
              <BriefCard brief={d?.chiefBrief} fallback={d?.morningFocus} />
            </AnimatedEntry>
            {/* Recovery grade */}
            <AnimatedEntry delay={20}>
              <TodayForecastCard forecast={d?.todayForecast} />
            </AnimatedEntry>
            {/* Streak / trend signals */}
            {d?.signals && d.signals.length > 0 && (
              <AnimatedEntry delay={40}>
                <BriefSignalsCard signals={d.signals} />
              </AnimatedEntry>
            )}
            {/* Alerts / highest-leverage flags */}
            {d?.alerts && d.alerts.length > 0 && (
              <AnimatedEntry delay={60}>
                <AlertCard alerts={d.alerts} />
              </AnimatedEntry>
            )}
            {/* Cross-domain patterns */}
            {d?.crossContextInsights && d.crossContextInsights.length > 0 && (
              <AnimatedEntry delay={80}>
                <CrossContextCard insights={d.crossContextInsights} />
              </AnimatedEntry>
            )}
            {/* Check-in trends */}
            <AnimatedEntry delay={100}>
              <CheckinHistoryCard insights={(d?.insights ?? []).filter((i) => {
                if (i.type === 'habit_consistency') return true;
                const nonHealth = new Set(['habits', 'wellbeing']);
                return i.domains?.every((dom: string) => nonHealth.has(dom)) ?? false;
              })} />
            </AnimatedEntry>
            {/* Weekly review + intentions */}
            <AnimatedEntry delay={120}>
              <WeeklyIntentionsCard review={d?.weeklyReview ?? null} actions={d?.leverageActions ?? []} />
            </AnimatedEntry>
            {/* Off-track forecasts */}
            {d && (d.forecasts ?? []).some((f) => f.status === 'off_track' || f.status === 'at_risk') && (
              <AnimatedEntry delay={180}>
                <ForecastCard forecasts={(d.forecasts ?? []).filter((f) => f.status === 'off_track' || f.status === 'at_risk')} />
              </AnimatedEntry>
            )}
            {/* Sleep log */}
            <AnimatedEntry delay={200}>
              <SleepLogCard />
            </AnimatedEntry>
            {/* NormOS profile — reference/settings, keep collapsible */}
            <AnimatedEntry delay={220}>
              <CollapsibleSection title="NormOS profile">
                <SelfModelCard />
              </CollapsibleSection>
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

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <SafeAreaView style={styles.safe}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { backgroundColor: c.background }]}
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
                {dailyLog.needsLog && (
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
      </SafeAreaView>

      <CheckinModal
        visible={checkinOpen}
        onClose={() => { setCheckinOpen(false); dailyLog.refresh(); }}
      />
      <AskOverlay bottomInset={bottomInset} />
      <TabBar active={tab} onChange={setTab} bottomInset={bottomInset} />
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
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
    marginTop: spacing.xs,
  },
  tabTitle: {
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
});
