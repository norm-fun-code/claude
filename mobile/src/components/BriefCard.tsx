import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, colors } from '../theme';
import type { ChiefBrief } from '../hooks/useBriefing';

interface Props {
  brief: ChiefBrief | null | undefined;
  /** Fallback single-paragraph focus, shown when the structured brief isn't ready yet. */
  fallback?: string;
}

// The Chief-of-Staff brief: one synthesized headline across domains, then three
// labeled blocks — THE ACTION (highest-leverage), THE RISK (trending wrong), THE
// MOVE (one number that changed). This is the centerpiece of the Today vision;
// everything else collapses beneath it.
const BLOCKS: { key: keyof Omit<ChiefBrief, 'synthesis'>; label: string; accent: string }[] = [
  { key: 'action', label: 'THE ACTION', accent: colors.green },
  { key: 'risk', label: 'THE RISK', accent: colors.red },
  { key: 'move', label: 'THE MOVE', accent: colors.accent },
];

export function BriefCard({ brief, fallback }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  // Nothing structured and no fallback → render nothing.
  if (!brief && !fallback) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <Text style={[styles.kicker, { color: c.subtext }]}>CHIEF OF STAFF</Text>

      {brief ? (
        <>
          <Text style={[styles.synthesis, { color: c.text }]}>{brief.synthesis}</Text>
          <View style={styles.blocks}>
            {BLOCKS.map(({ key, label, accent }) => (
              <View key={key} style={styles.block}>
                <View style={styles.blockHeader}>
                  <View style={[styles.dot, { backgroundColor: accent }]} />
                  <Text style={[styles.blockLabel, { color: accent }]}>{label}</Text>
                </View>
                <Text style={[styles.blockText, { color: c.text }]}>{brief[key]}</Text>
              </View>
            ))}
          </View>
        </>
      ) : (
        <Text style={[styles.synthesis, { color: c.text }]}>{fallback}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  kicker: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: spacing.sm,
  },
  synthesis: {
    fontSize: 19,
    fontWeight: '600',
    lineHeight: 27,
    letterSpacing: -0.3,
  },
  blocks: {
    marginTop: spacing.md,
    gap: spacing.md,
  },
  block: {
    gap: 4,
  },
  blockHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  blockLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  blockText: {
    ...typography.body,
    fontSize: 15,
    lineHeight: 22,
  },
});
