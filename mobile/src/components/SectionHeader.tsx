import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, typography, tileTint, withAlpha } from '../theme';

interface Props {
  emoji: string;
  title: string;
  preserveCase?: boolean;
  // Named tint (key into theme.tileTint) for the emoji's tile — lets a hero
  // card color its chip to its domain (Recovery green, Health red, …) while
  // everything else shares the calm default accent tile.
  tint?: keyof typeof tileTint;
}

// The emoji sits in a soft, tinted rounded tile — an "app-icon" chip — so it
// reads as intentional iconography rather than an inline text decoration, and
// every section header across the app shares one consistent, premium treatment.
export function SectionHeader({ emoji, title, preserveCase, tint = 'accent' }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const base = tileTint[tint] ?? tileTint.accent;

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.tile,
          {
            backgroundColor: withAlpha(base, isDark ? 0.20 : 0.13),
            borderColor: withAlpha(base, isDark ? 0.30 : 0.22),
          },
        ]}
      >
        {/* color only affects plain text glyphs (↗, ◆) — true emoji ignore it.
            Without this, dark glyphs vanish against the dark-mode tile. */}
        <Text style={[styles.emoji, { color: base }]}>{emoji}</Text>
      </View>
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
  tile: {
    width: 30,
    height: 30,
    borderRadius: 9,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 15,
    // Nudge the glyph onto the optical center of the tile.
    lineHeight: 19,
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
