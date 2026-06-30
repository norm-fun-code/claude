import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, typography } from '../theme';

interface Props {
  emoji: string;
  title: string;
  preserveCase?: boolean;
}

export function SectionHeader({ emoji, title, preserveCase }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>{emoji}</Text>
      <Text style={[styles.title, { color: c.text }, preserveCase && styles.preserve]}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
    marginTop: spacing.xs,
  },
  emoji: {
    fontSize: 16,
  },
  title: {
    ...typography.label,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.9,
  },
  preserve: {
    textTransform: 'none',
    fontSize: 15,
    letterSpacing: -0.2,
  },
});
