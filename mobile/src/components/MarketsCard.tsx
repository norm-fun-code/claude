import React from 'react';
import { View, Text, StyleSheet, Linking, TouchableOpacity, useColorScheme } from 'react-native';
import { getColors, spacing, radius, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import type { Markets } from '../hooks/useBriefing';

interface Props {
  markets: Markets | null | undefined;
}

// Top finance/markets headlines for the day (WSJ via RSS).
export function MarketsCard({ markets }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const headlines = markets?.headlines ?? [];
  if (headlines.length === 0) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, shadow(isDark)]}>
      <SectionHeader emoji="📰" title="Markets Today" />

      {headlines.length > 0 && (
        <View style={styles.headlines}>
          {headlines.map((h, i) => (
            <TouchableOpacity
              key={i}
              activeOpacity={h.url ? 0.6 : 1}
              onPress={() => h.url && Linking.openURL(h.url)}
              style={[styles.headlineRow, i > 0 && { borderTopColor: c.border, borderTopWidth: 1 }]}
            >
              <Text style={[styles.headlineText, { color: c.text }]} numberOfLines={2}>
                {h.title}
              </Text>
              <Text style={[styles.headlineSource, { color: c.subtext }]}>{h.source}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  headlines: { marginTop: spacing.sm },
  headlineRow: { paddingVertical: spacing.sm },
  headlineText: { fontSize: 14, fontWeight: '500', lineHeight: 19 },
  headlineSource: { fontSize: 11, marginTop: 2 },
});
