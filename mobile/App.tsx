import React, { useCallback, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  RefreshControl,
  Text,
  useColorScheme,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { useBriefing } from './src/hooks/useBriefing';
import { useHealthData } from './src/hooks/useHealthData';
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
import { HabitsCard } from './src/components/HabitsCard';
import { HealthCard } from './src/components/HealthCard';
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

export default function App() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const briefing = useBriefing();
  const health = useHealthData();
  usePushRegistration(); // register this phone for proactive nudges

  const [tab, setTab] = useState<TabKey>('today');
  const isRefreshing = briefing.loading || health.loading;

  const onRefresh = useCallback(() => {
    briefing.refetch();
    health.refetch();
  }, [briefing, health]);

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
            <HealthCard health={health} />
            {d?.healthInsights && d.healthInsights.length > 0 ? (
              <InsightsCard insights={d.healthInsights} />
            ) : (
              <EmptyNote c={c} text="Health insights (sleep ↔ HRV ↔ focus patterns) appear once a few days of Apple Health + habit data accumulate. Open the app daily so HealthKit syncs, and log your habits on the Today tab." />
            )}
            <WorkoutsPanel hrv={health.hrv} isDark={isDark} />
          </>
        );
      case 'wealth':
        return (
          <>
            <WealthCard wealth={d?.wealth ?? null} />
            <AdvisorCard />
            <IndicesCard />
            <MarketsCard markets={d?.markets} />
            <InsightsCard insights={d?.wealthInsights ?? []} />
            {!d?.wealth && (
              <EmptyNote c={c} text="Connect Monarch (your monthly export) to see net worth, spending, and cashflow here." />
            )}
          </>
        );
      case 'wisdom':
        return (
          <>
            {d?.relevantHighlight && <LibraryCard highlight={d.relevantHighlight} />}
            <ChatCard />
            {(d?.quote || d?.quoteInsight) && <QuoteCard quote={d!.quote} insight={d!.quoteInsight} />}
            {(d?.notionText || d?.notionInsight) && (
              <NotionCard pageTitle={d?.notionPageTitle ?? ''} notionText={d!.notionText} insight={d!.notionInsight} />
            )}
          </>
        );
      case 'insights':
        return (
          <>
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
            <WeatherCard weather={d?.weather ?? null} />
            {d?.dailyQuote && <QuoteCard quote={d.dailyQuote} insight="" title="Quote" emoji="❝" />}
            <CheckinCard />
            <HabitsCard />
            {d && <LeverageCard actions={d.leverageActions ?? []} insights={[]} />}
            {d && <ForecastCard forecasts={(d.forecasts ?? []).filter((f) => f.status === 'off_track' || f.status === 'at_risk')} />}
            {d && d.calendar.length > 0 && <CalendarCard events={d.calendar} />}
            {d && <UrgentEmailsCard emails={d.urgentEmails} />}
            {d && <NewsletterList newsletters={d.newsletters} />}
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
        <Text style={[styles.tabTitle, { color: c.text }]}>{tabTitle}</Text>
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
  tabTitle: {
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.5,
    marginBottom: spacing.md,
    marginTop: spacing.xs,
  },
  errorBox: { borderWidth: 1, borderRadius: 12, padding: spacing.md, marginBottom: spacing.md },
  errorTitle: { fontSize: 16, fontWeight: '600', marginBottom: spacing.xs },
  errorMsg: { fontSize: 14, lineHeight: 21, marginBottom: spacing.sm },
  errorDetail: { fontSize: 12, fontStyle: 'italic' },
  loadingBlock: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.md },
  loadingText: { fontSize: 14, fontStyle: 'italic' },
  empty: { borderWidth: 1, borderRadius: 14, padding: spacing.lg, marginBottom: spacing.md },
  emptyText: { fontSize: 14, lineHeight: 21, fontStyle: 'italic' },
  footer: { height: spacing.lg },
});
