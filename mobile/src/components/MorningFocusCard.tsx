import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';

interface Props {
  focus: string | null | undefined;
}

export function MorningFocusCard({ focus }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!focus) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.accent }, shadow(isDark)]}>
      <View style={styles.header}>
        <Text style={styles.label}>CHIEF OF STAFF BRIEF</Text>
      </View>
      <Text style={styles.text}>{focus}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  header: {
    marginBottom: spacing.sm,
  },
  label: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: 'rgba(255,255,255,0.7)',
  },
  text: {
    ...typography.body,
    color: '#fff',
    lineHeight: 23,
  },
});
