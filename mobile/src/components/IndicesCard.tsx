import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
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

// S&P 500 + NASDAQ day performance — a compact scoreboard above the news.
export function IndicesCard({ markets }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const indices = markets?.indices ?? [];
  if (indices.length === 0) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, shadow(isDark)]}>
      <SectionHeader emoji="📊" title="Today's Market" />
      <View style={styles.row}>
        {indices.map((idx) => {
          const up = idx.change >= 0;
          const tint = up ? colors.green : colors.red;
          return (
            <View key={idx.symbol} style={[styles.cell, { borderColor: c.border }]}>
              <Text style={[styles.label, { color: c.subtext }]}>{idx.label}</Text>
              <Text style={[styles.price, { color: c.text }]}>{fmtPrice(idx.price)}</Text>
              <View style={[styles.pill, { backgroundColor: tint + '1A' }]}>
                <Text style={[styles.change, { color: tint }]}>
                  {up ? '▲' : '▼'} {fmtChange(idx.changePct)}%
                </Text>
              </View>
              <Text style={[styles.changeAbs, { color: c.subtext }]}>{fmtChange(idx.change)} pts</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  row: { flexDirection: 'row', gap: spacing.sm },
  cell: {
    flex: 1,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.sm,
    alignItems: 'flex-start',
    gap: 3,
  },
  label: { ...typography.label, fontSize: 10 },
  price: { fontSize: 22, fontWeight: '700', letterSpacing: -0.6 },
  pill: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2, marginTop: 1 },
  change: { fontSize: 13, fontWeight: '700' },
  changeAbs: { fontSize: 11 },
});
