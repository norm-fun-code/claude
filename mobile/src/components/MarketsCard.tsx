import React from 'react';
import { View, Text, StyleSheet, Linking, TouchableOpacity, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, colors, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import type { Markets } from '../hooks/useBriefing';

interface Props {
  markets: Markets | null | undefined;
}

function fmtPrice(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtChange(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Live index levels (S&P 500, NASDAQ) + top finance/markets headlines.
export function MarketsCard({ markets }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const indices = markets?.indices ?? [];
  const headlines = markets?.headlines ?? [];
  if (indices.length === 0 && headlines.length === 0) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, shadow(isDark)]}>
      <SectionHeader emoji="📈" title="Markets Today" />

      {indices.length > 0 && (
        <View style={styles.indexRow}>
          {indices.map((idx) => {
            const up = idx.change >= 0;
            const tint = up ? colors.green : colors.red;
            return (
              <View key={idx.symbol} style={[styles.indexCell, { borderColor: c.border }]}>
                <Text style={[styles.indexLabel, { color: c.subtext }]}>{idx.label}</Text>
                <Text style={[styles.indexPrice, { color: c.text }]}>{fmtPrice(idx.price)}</Text>
                <Text style={[styles.indexChange, { color: tint }]}>
                  {up ? '▲' : '▼'} {fmtChange(idx.change)} ({fmtChange(idx.changePct)}%)
                </Text>
              </View>
            );
          })}
        </View>
      )}

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
  indexRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xs },
  indexCell: {
    flex: 1,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.sm,
    gap: 2,
  },
  indexLabel: { ...typography.label, fontSize: 10 },
  indexPrice: { fontSize: 20, fontWeight: '700', letterSpacing: -0.5 },
  indexChange: { fontSize: 12, fontWeight: '600' },
  headlines: { marginTop: spacing.sm },
  headlineRow: { paddingVertical: spacing.sm },
  headlineText: { fontSize: 14, fontWeight: '500', lineHeight: 19 },
  headlineSource: { fontSize: 11, marginTop: 2 },
});
