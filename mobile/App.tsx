import React, { useCallback, useState } from 'react';
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
} from 'react-native';
import { StatusBar } from 'expo-status-bar';

// NormOS is always light (off-white) — easier to read; ignore system dark mode.
Appearance.setColorScheme('light');

import { useBriefing } from './src/hooks/useBriefing';
import { useHealthData } from './src/hooks/useHealthData';
import { useRecovery } from './src/hooks/useRecovery';
import { usePushRegistration } from './src/hooks/usePushRegistration';
import { getColors, spacing } from './src/theme';

import { Header } from './src/components/Header';
import { TabBar, TabKey, TABS } from './src/components/TabBar';
import { LeverageCard } from './src/components/LeverageCard';
import { ForecastCard } from './src/components/ForecastCard';
import { LibraryCard } from './src/components/LibraryCard';
import { ReviewCard } from './src/components/ReviewCard';
import { WealthCard } from './src/components/WealthCard';
import { InsightsCard } from './src/components/InsightsCard';
import { ChatCard } from './src/components/ChatCard';
import { CheckinCard } from './src/components/CheckinCard';
import { WeeklyIntentionsCard } from './src/components/WeeklyIntentionsCard';
import { HabitsCard } from './src/components/HabitsCard';
import { HealthCard } from './src/components/HealthCard';
import { RecoveryCard } from './src/components/RecoveryCard';
import { WeatherCard } from './src/components/WeatherCard';
import { WorkoutsPanel } from './src/components/WorkoutsPanel';
import { CalendarCard } from './src/components/CalendarCard';
import { QuoteCard } from './src/components/QuoteCard';
import { NotionCard } from './src/components/NotionCard';
import { NewsletterList } from './src/components/NewsletterList';
import { MarketsCard } from './src/components/MarketsCard';
import { IndicesCard } from './src/components/IndicesCard';
import { AdvisorCard } from './src/components/AdvisorCard';
import { UrgentEmailsCard } from './src/components/UrgentEmailsCard';
import { AlertCard } from './src/components/AlertCard';
import { HighlightsCard } from './src/components/HighlightsCard';
import { ShopCard } from './src/components/ShopCard';
import { GoalsCard } from './src/components/GoalsCard';
import { AnnotationsCard } from './src/components/AnnotationsCard';
import { WeeklyStateCard } from './src/components/WeeklyStateCard';
import { ANALYZE_URL, authHeaders, fetchWithTimeout } from './src/config';

export default function App() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const briefing = useBriefing();
  const health = useHealthData();
  const liveRecovery = useRecovery();

  const [tab, setTab] = useState<TabKey>('today');
  const [analyzingInsights, setAnalyzingInsights] = useState(false);
  // Health tab refresh only spins on health-local fetches; other tabs spin on
  // the briefing too.
  const isRefreshing =
    tab === 'health' ? health.loading || liveRecovery.loading : briefing.loading || health.loading;

  const refreshInsights = useCallback(async () => {
    if (analyzingInsights) return;
    setAnalyzingInsights(true);
    try {
      await fetchWithTimeout(ANALYZE_URL, { method: 'POST', headers: authHeaders() }, 60000);
      briefing.reload();
    } catch { /* silent */ } finally {
      setAnalyzingInsights(false);
    }
  }, [analyzingInsights, briefing]);

  // Pull-to-refresh is always CHEAP: device HealthKit (instant) + the warm
  // server cache (instant) + the fast recovery endpoint on Health. Nothing
  // here triggers an LLM or a briefing rebuild — that's what each tab's
  // explicit refresh button is for, so you choose what to spend time updating.
  const onRefresh = useCallback(() => {
    health.refetch();
    if (tab === 'health') liveRecovery.refetch();
    else briefing.reload();
  }, [briefing, health, liveRecovery, tab]);

  // Per-tab explicit refresh — each tab updates only its own content:
  //   Today/Wealth → markets brief + email summaries (server partial, ~10-20s)
  //   Health       → HealthKit + live recovery score (sub-second)
  //   Insights     → re-run the analysis engine, then reload findings
  //   Wisdom       → day-locked by design; reloads the morning cache
  const tabRefresh: Partial<Record<TabKey, { label: string; busy: boolean; run: () => void }>> = {
    today: { label: 'Update markets & email', busy: briefing.loading, run: briefing.refetchLive },
    wealth: { label: 'Update markets & email', busy: briefing.loading, run: briefing.refetchLive },
    health: {
      label: 'Refresh health data',
      busy: health.loading || liveRecovery.loading,
      run: () => { health.refetch(); liveRecovery.refetch(); },
    },
    insights: { label: 'Re-run analysis', busy: analyzingInsights, run: refreshInsights },
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

  const d = briefing.data;
  const tabTitle = TABS.find((t) => t.key === tab)?.label ?? '';

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
            {d?.healthInsights && d.healthInsights.length > 0 ? (
              <InsightsCard insights={d.healthInsights} />
            ) : (
              <EmptyNote c={c} text="Health insights (sleep ↔ HRV ↔ focus patterns) appear once a few days of Apple Health + habit data accumulate. Open the app daily so HealthKit syncs, and log your habits on the Today tab." />
            )}
            <TouchableOpacity onPress={refreshInsights} disabled={analyzingInsights} style={styles.refreshInsightsBtn}>
              {analyzingInsights
                ? <ActivityIndicator size="small" color={c.subtext} />
                : <Text style={[styles.refreshInsightsTxt, { color: c.subtext }]}>Refresh insights</Text>
              }
            </TouchableOpacity>
            <WorkoutsPanel hrv={health.hrv} isDark={isDark} />
          </>
        );
      case 'wealth':
        return (
          <>
            <WealthCard wealth={d?.wealth ?? null} />
            <InsightsCard insights={d?.wealthInsights ?? []} />
            <AdvisorCard />
            <IndicesCard />
            <MarketsCard markets={d?.markets} />
            {!d?.wealth && (
              <EmptyNote c={c} text="Connect Monarch (your monthly export) to see net worth, spending, and cashflow here." />
            )}
          </>
        );
      case 'wisdom':
        return (
          <>
            <HighlightsCard />
            <ChatCard />
            {(d?.quote || d?.quoteInsight) && <QuoteCard quote={d!.quote} insight={d!.quoteInsight} />}
            {(d?.notionText || d?.notionInsight) && (
              <NotionCard pageTitle={d?.notionPageTitle ?? ''} notionText={d!.notionText} quote={d?.notionQuote} insight={d!.notionInsight} />
            )}
          </>
        );
      case 'shop':
        return <ShopCard />;
      case 'insights':
        return (
          <>
            <WeeklyStateCard briefing={d ?? null} health={health} />
            <GoalsCard weeklyGoals={d?.weeklyGoals} />
            <ReviewCard review={d?.weeklyReview ?? null} />
            <ForecastCard forecasts={d?.forecasts ?? []} />
            <InsightsCard insights={d?.insights ?? []} />
            {!d && !briefing.loading && <EmptyNote c={c} text="Insights appear after your first analyze run." />}
          </>
        );
      case 'today':
      default:
        return (
          <>
            {d?.alerts && d.alerts.length > 0 && <AlertCard alerts={d.alerts} />}
            <WeeklyIntentionsCard />
            <WeatherCard weather={d?.weather ?? null} />
            {d && (d.calendar?.length ?? 0) > 0 && <CalendarCard events={d.calendar} />}
            {d?.dailyQuote && <QuoteCard quote={d.dailyQuote} insight="" title="Quote" emoji="❝" />}
            <CheckinCard />
            <HabitsCard />
            <AnnotationsCard />
            {d && <LeverageCard actions={d.leverageActions ?? []} insights={[]} />}
            {d && <ForecastCard forecasts={(d.forecasts ?? []).filter((f) => f.status === 'off_track' || f.status === 'at_risk')} />}
            {d && <UrgentEmailsCard emails={d.urgentEmails ?? []} />}
            {d && <NewsletterList newsletters={d.newsletters ?? []} />}
            <ReviewCard review={d?.weeklyReview ?? null} compact />
            {d?.relevantHighlight && <LibraryCard highlight={d.relevantHighlight} />}

            {briefing.error && !d && (
              <View style={[styles.errorBox, { borderColor: c.border, backgroundColor: c.card }]}>
                <Text style={[styles.errorTitle, { color: c.text }]}>Cannot reach backend</Text>
                <Text style={[styles.errorMsg, { color: c.subtext }]}>
                  Make sure the backend is running:{'\n'}cd backend && node server.js
                </Text>
                <Text style={[styles.errorDetail, { color: c.subtext }]}>{briefing.error}</Text>
              </View>
            )}
            {briefing.loading && !d && (
              <View style={styles.loadingBlock}>
                <ActivityIndicator color={c.subtext} />
                <Text style={[styles.loadingText, { color: c.subtext }]}>Generating your briefing…</Text>
              </View>
            )}
          </>
        );
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { backgroundColor: c.background }]}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={c.subtext} />}
        showsVerticalScrollIndicator={false}
      >
        <Header date={d?.date ?? today} isRefreshing={isRefreshing} />
        <View style={styles.titleRow}>
          <Text style={[styles.tabTitle, { color: c.text }]}>{tabTitle}</Text>
          {tabRefresh[tab] && (
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
          )}
        </View>
        {renderTab()}
        <View style={styles.footer} />
      </ScrollView>

      <TabBar active={tab} onChange={setTab} />
    </SafeAreaView>
  );
}

function EmptyNote({ c, text }: { c: ReturnType<typeof getColors>; text: string }) {
  return (
    <View style={[styles.empty, { borderColor: c.border, backgroundColor: c.card }]}>
      <Text style={[styles.emptyText, { color: c.subtext }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
  tabRefreshBtn: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 6,
    minWidth: 60,
    alignItems: 'center',
  },
  tabRefreshTxt: { fontSize: 12, fontWeight: '600' },
  errorBox: { borderWidth: 1, borderRadius: 12, padding: spacing.md, marginBottom: spacing.md },
  errorTitle: { fontSize: 16, fontWeight: '600', marginBottom: spacing.xs },
  errorMsg: { fontSize: 14, lineHeight: 21, marginBottom: spacing.sm },
  errorDetail: { fontSize: 12, fontStyle: 'italic' },
  loadingBlock: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.md },
  loadingText: { fontSize: 14, fontStyle: 'italic' },
  empty: { borderWidth: 1, borderRadius: 14, padding: spacing.lg, marginBottom: spacing.md },
  emptyText: { fontSize: 14, lineHeight: 21, fontStyle: 'italic' },
  footer: { height: spacing.lg },
  refreshInsightsBtn: { alignItems: 'center', paddingVertical: spacing.sm, marginBottom: spacing.md },
  refreshInsightsTxt: { fontSize: 13, fontWeight: '500' },
});
