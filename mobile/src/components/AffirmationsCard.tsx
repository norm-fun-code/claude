import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius } from '../theme';
import { SectionHeader } from './SectionHeader';

const AFFIRMATIONS = [
  'I show up with joy, presence, and courage!',
  'Everything always works out!',
  'We will always live and love in abundance!',
];

export function AffirmationsCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="✨" title="Daily Affirmations" />
      {AFFIRMATIONS.map((text, i) => (
        <View key={i} style={[styles.row, { borderColor: c.border, borderTopWidth: i === 0 ? 0 : 1 }]}>
          <Text style={[styles.text, { color: c.text }]}>{text}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  row: {
    paddingVertical: spacing.sm,
  },
  text: {
    fontSize: 15,
    fontWeight: '500',
    lineHeight: 22,
    fontStyle: 'italic',
  },
});
