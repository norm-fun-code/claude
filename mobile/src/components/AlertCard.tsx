import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import type { Alert } from '../hooks/useBriefing';

interface Props {
  alerts: Alert[];
}

// Surfaces source-health warnings (e.g. Monarch token expired so the daily
// sync stopped). Amber for warnings, red for high severity. Hidden when empty.
export function AlertCard({ alerts }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!alerts || alerts.length === 0) return null;

  return (
    <>
      {alerts.map((a, i) => {
        const high = a.severity === 'high';
        const accent = high ? '#C0392B' : '#B7791F';
        const bg = high ? (isDark ? '#2A1512' : '#FDEDEB') : isDark ? '#2A2412' : '#FDF6E3';
        return (
          <View
            key={`${a.source}-${i}`}
            style={[styles.card, { backgroundColor: bg, borderColor: accent }]}
          >
            <Text style={[styles.title, { color: accent }]}>
              {high ? '⚠︎ Action needed' : '⚠︎ Heads up'}
            </Text>
            <Text style={[styles.message, { color: c.text }]}>{a.message}</Text>
          </View>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderLeftWidth: 4,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  title: {
    ...typography.body,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  message: {
    ...typography.body,
    lineHeight: 22,
  },
});
