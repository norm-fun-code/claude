import React from 'react';
import { View, Text, StyleSheet, useColorScheme, ActivityIndicator, TouchableOpacity } from 'react-native';
import { getColors, spacing, typography } from '../theme';

interface Props {
  date: string;
  isRefreshing?: boolean;
  onRefresh?: () => void;
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning, Norm';
  if (hour < 17) return 'Good afternoon, Norm';
  return 'Good evening, Norm';
}

export function Header({ date, isRefreshing, onRefresh }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  return (
    <View style={styles.container}>
      <View style={styles.textBlock}>
        <Text style={[styles.greeting, { color: c.text }]}>{getGreeting()}</Text>
        <Text style={[styles.date, { color: c.subtext }]}>{date}</Text>
      </View>
      {/* Global quick-refresh: loads cached briefing + fresh HealthKit data.
          For heavy rebuilds (LLM), use the per-tab button instead. */}
      <TouchableOpacity
        onPress={onRefresh}
        disabled={isRefreshing || !onRefresh}
        style={styles.refreshBtn}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      >
        {isRefreshing
          ? <ActivityIndicator size="small" color={c.subtext} />
          : <Text style={[styles.refreshIcon, { color: c.subtext }]}>↺</Text>
        }
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
  },
  textBlock: {
    flex: 1,
  },
  greeting: {
    ...typography.title,
    fontSize: 28,
    marginBottom: spacing.xs,
  },
  date: {
    ...typography.body,
    fontSize: 15,
  },
  refreshBtn: {
    marginTop: spacing.xs,
    marginLeft: spacing.md,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  refreshIcon: {
    fontSize: 22,
    fontWeight: '300',
  },
});
