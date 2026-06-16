import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import type { ChiefBrief } from '../hooks/useBriefing';

interface Props {
  brief: ChiefBrief | null | undefined;
  /** Fallback single-paragraph focus, shown when the structured brief isn't ready yet. */
  fallback?: string;
}

const BLOCKS: { key: keyof Omit<ChiefBrief, 'synthesis'>; label: string }[] = [
  { key: 'action', label: 'THE ACTION' },
  { key: 'risk', label: 'THE RISK' },
  { key: 'move', label: 'THE MOVE' },
];

// The Chief of Staff closes every brief on these — a fixed daily anchor.
const AFFIRMATIONS = [
  'I show up with joy, presence, and courage!',
  'Everything always works out!',
  'We will always live and love in abundance!',
];

export function BriefCard({ brief, fallback }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!brief && !fallback) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.accent }, shadow(isDark)]}>
      <Text style={styles.kicker}>CHIEF OF STAFF BRIEF</Text>

      {brief ? (
        <>
          <Text style={styles.synthesis}>{brief.synthesis}</Text>
          <View style={styles.separator} />
          {BLOCKS.map(({ key, label }) => (
            <View key={key} style={styles.block}>
              <Text style={styles.blockLabel}>{label}</Text>
              <Text style={styles.blockText}>{brief[key]}</Text>
            </View>
          ))}
        </>
      ) : (
        <Text style={styles.synthesis}>{fallback}</Text>
      )}

      {/* Affirmations — the Chief of Staff closes every brief on an up note. */}
      <View style={styles.separator} />
      <Text style={styles.blockLabel}>AFFIRMATIONS</Text>
      {AFFIRMATIONS.map((text, i) => (
        <View key={i} style={styles.affRow}>
          <Text style={styles.affBullet}>✦</Text>
          <Text style={styles.affText}>{text}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  kicker: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: 'rgba(255,255,255,0.7)',
    marginBottom: spacing.sm,
  },
  synthesis: {
    ...typography.body,
    color: '#fff',
    lineHeight: 23,
    marginBottom: spacing.md,
  },
  separator: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.2)',
    marginBottom: spacing.md,
  },
  block: {
    marginBottom: spacing.sm + 2,
  },
  blockLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: 'rgba(255,255,255,0.65)',
    marginBottom: 3,
  },
  blockText: {
    ...typography.body,
    color: '#fff',
    fontSize: 14,
    lineHeight: 21,
  },
  affRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginTop: 5,
  },
  affBullet: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    lineHeight: 21,
  },
  affText: {
    ...typography.body,
    color: '#fff',
    fontSize: 14,
    lineHeight: 21,
    fontStyle: 'italic',
    flex: 1,
  },
});
