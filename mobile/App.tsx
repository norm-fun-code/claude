import React, { useCallback, useRef } from 'react';
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
import { getColors, spacing } from './src/theme';

import { Header } from './src/components/Header';
import { LeverageCard } from './src/components/LeverageCard';
import { ChatCard } from './src/components/ChatCard';
import { CheckinCard } from './src/components/CheckinCard';
import { HealthCard } from './src/components/HealthCard';
import { WeatherCard } from './src/components/WeatherCard';
import { WorkoutCard } from './src/components/WorkoutCard';
import { CalendarCard } from './src/components/CalendarCard';
import { QuoteCard } from './src/components/QuoteCard';
import { NotionCard } from './src/components/NotionCard';
import { NewsletterList } from './src/components/NewsletterList';
import { FinanceCard } from './src/components/FinanceCard';
import { UrgentEmailsCard } from './src/components/UrgentEmailsCard';

export default function App() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const briefing = useBriefing();
  const health = useHealthData();

  const isRefreshing = briefing.loading || health.loading;

  const onRefresh = useCallback(() => {
    briefing.refetch();
    health.refetch();
  }, [briefing, health]);

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.background }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { backgroundColor: c.background }]}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={onRefresh}
            tintColor={c.subtext}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <Header date={briefing.data?.date ?? today} isRefreshing={isRefreshing} />

        {/* Highest leverage actions — the front page */}
        {briefing.data && (
          <LeverageCard
            actions={briefing.data.leverageActions ?? []}
            insights={briefing.data.insights ?? []}
          />
        )}

        {/* Daily check-in — the subjective signal */}
        <CheckinCard />

        {/* Ask NormOS — chat grounded in your data + library */}
        <ChatCard />

        {/* Health — always shown (on-device data) */}
        <HealthCard health={health} />

        {/* Weather */}
        <WeatherCard weather={briefing.data?.weather ?? null} />

        {/* Workout — combines server plan with local HRV */}
        {briefing.data?.workout && (
          <WorkoutCard workout={briefing.data.workout} hrvStatus={health.hrvStatus} />
        )}

        {/* Calendar */}
        <CalendarCard events={briefing.data?.calendar ?? []} />

        {/* Quote */}
        {(briefing.data?.quote || briefing.data?.quoteInsight) && (
          <QuoteCard
            quote={briefing.data.quote}
            insight={briefing.data.quoteInsight}
          />
        )}

        {/* Notion */}
        {(briefing.data?.notionText || briefing.data?.notionInsight) && (
          <NotionCard
            pageTitle={briefing.data?.notionPageTitle ?? ''}
            notionText={briefing.data.notionText}
            insight={briefing.data.notionInsight}
          />
        )}

        {/* Newsletters */}
        {briefing.data && (
          <NewsletterList newsletters={briefing.data.newsletters} />
        )}

        {/* Finance */}
        {briefing.data?.financeSummary && briefing.data.financeSummary.length > 0 && (
          <FinanceCard items={briefing.data.financeSummary} />
        )}

        {/* Urgent emails */}
        {briefing.data && (
          <UrgentEmailsCard emails={briefing.data.urgentEmails} />
        )}

        {/* Backend error notice */}
        {briefing.error && !briefing.data && (
          <View style={[styles.errorBox, { borderColor: c.border, backgroundColor: c.card }]}>
            <Text style={[styles.errorTitle, { color: c.text }]}>Cannot reach backend</Text>
            <Text style={[styles.errorMsg, { color: c.subtext }]}>
              Make sure the backend is running:{'\n'}cd backend && node server.js
            </Text>
            <Text style={[styles.errorDetail, { color: c.subtext }]}>{briefing.error}</Text>
          </View>
        )}

        {/* Loading state (first load, no data yet) */}
        {briefing.loading && !briefing.data && (
          <View style={styles.loadingBlock}>
            <ActivityIndicator color={c.subtext} />
            <Text style={[styles.loadingText, { color: c.subtext }]}>
              Generating your briefing…
            </Text>
          </View>
        )}

        <View style={styles.footer} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl,
  },
  errorBox: {
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  errorMsg: {
    fontSize: 14,
    lineHeight: 21,
    marginBottom: spacing.sm,
  },
  errorDetail: {
    fontSize: 12,
    fontStyle: 'italic',
  },
  loadingBlock: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    gap: spacing.md,
  },
  loadingText: {
    fontSize: 14,
    fontStyle: 'italic',
  },
  footer: {
    height: spacing.xl,
  },
});
