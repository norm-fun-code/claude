import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, typography } from '../theme';

interface Props {
  date: string;
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning, Norm';
  if (hour < 17) return 'Good afternoon, Norm';
  return 'Good evening, Norm';
}

// Cheap refresh is handled by pull-to-refresh; heavy/explicit refresh by each
// tab's labeled button. The header is just greeting + date (no refresh icon).
export function Header({ date }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  return (
    <View style={styles.container}>
      <View style={styles.textBlock}>
        <Text style={[styles.greeting, { color: c.text }]}>{getGreeting()}</Text>
        <Text style={[styles.date, { color: c.subtext }]}>{date}</Text>
      </View>
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
});
