import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { WEALTH_ALLOCATION_URL, authHeaders, fetchWithTimeout } from '../config';

type Slice = { cls: string; label: string; value: number; pct: number };
type Position = { name: string; value: number; kind: 'holding' | 'private'; single?: boolean; pctNw: number | null; pctPort: number | null };
type Concentration = { name: string; balance: number; pct: number; kind: string; illiquid: boolean } | null;
type AllocationView = {
  available: boolean;
  total: number;
  netWorth: number | null;
  slices: Slice[];
  positions: Position[];
  positionsTotal: number;
  concentration: Concentration;
};

// Stable colors per asset class (color-blind-friendly-ish, distinct hues).
const CLASS_COLOR: Record<string, string> = {
  investments: '#4C6FFF', // stocks
  real_estate: '#34A853', // real estate
  cash: '#00B8A9',        // cash
  retirement: '#9B6DFF',  // retirement
  crypto: '#F4A100',      // crypto
  other: '#EC6A5E',       // other (private stock, alts)
};

function money(n: number) {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
function pctLabel(frac: number) {
  return `${Math.round(frac * 100)}%`;
}

// Asset Mix: how net worth is composed (allocation bar) + a single-name
// concentration callout (e.g. a large pre-IPO stock position). A structural,
// standing view — distinct from the daily spending/budget insights.
function AssetMixCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [data, setData] = useState<AllocationView | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTimeout(WEALTH_ALLOCATION_URL, { headers: authHeaders() });
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled && json?.available) setData(json);
      } catch {
        // best-effort — card simply doesn't render
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!data || !data.slices?.length) return null;
  const { slices, concentration, positions } = data;
  const maxPos = positions && positions.length ? positions[0].value : 0;

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="🧬" title="Asset Mix" tint="gold" />

      {/* Stacked allocation bar */}
      <View style={styles.bar}>
        {slices.map((s, i) => (
          <View
            key={s.cls}
            style={{
              width: `${Math.max(0.5, s.pct * 100)}%`,
              backgroundColor: CLASS_COLOR[s.cls] || '#999',
              borderTopLeftRadius: i === 0 ? 6 : 0,
              borderBottomLeftRadius: i === 0 ? 6 : 0,
              borderTopRightRadius: i === slices.length - 1 ? 6 : 0,
              borderBottomRightRadius: i === slices.length - 1 ? 6 : 0,
            }}
          />
        ))}
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        {slices.map((s) => (
          <View key={s.cls} style={styles.legendRow}>
            <View style={[styles.dot, { backgroundColor: CLASS_COLOR[s.cls] || '#999' }]} />
            <Text style={[styles.legendLabel, { color: c.text }]} numberOfLines={1}>
              {s.label}
            </Text>
            <Text style={[styles.legendPct, { color: c.text }]}>{pctLabel(s.pct)}</Text>
            <Text style={[styles.legendVal, { color: c.subtext }]}>{money(s.value)}</Text>
          </View>
        ))}
      </View>

      {/* Top individual holdings — drills into the Stocks bucket. */}
      {positions && positions.length > 0 && (
        <View style={styles.holdings}>
          <Text style={[styles.subhead, { color: c.subtext }]}>TOP HOLDINGS</Text>
          {positions.map((p) => (
            <View key={`${p.name}-${p.value}`} style={styles.holdingRow}>
              <View style={styles.holdingLeft}>
                <Text style={[styles.holdingName, { color: c.text }]} numberOfLines={1}>
                  {p.name}
                  {p.kind === 'private' ? <Text style={[styles.privateTag, { color: c.subtext }]}>  private</Text> : null}
                </Text>
                <View style={[styles.holdingBarTrack, { backgroundColor: c.border }]}>
                  <View
                    style={[
                      styles.holdingBarFill,
                      { width: `${maxPos > 0 ? Math.max(3, (p.value / maxPos) * 100) : 0}%`, backgroundColor: p.kind === 'private' ? CLASS_COLOR.other : CLASS_COLOR.investments },
                    ]}
                  />
                </View>
              </View>
              <View style={styles.holdingRight}>
                <Text style={[styles.holdingVal, { color: c.text }]}>{money(p.value)}</Text>
                {p.pctNw != null && (
                  <Text style={[styles.holdingPct, { color: c.subtext }]}>{pctLabel(p.pctNw)} of NW</Text>
                )}
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Single-name concentration callout */}
      {concentration && (
        <View style={[styles.concBox, { backgroundColor: (isDark ? '#EC6A5E' : '#EC6A5E') + '1A', borderColor: '#EC6A5E55' }]}>
          <Text style={[styles.concTitle, { color: c.text }]}>
            {concentration.name} is {pctLabel(concentration.pct)} of net worth
          </Text>
          <Text style={[styles.concBody, { color: c.subtext }]}>
            {money(concentration.balance)} in one position{concentration.illiquid ? ' — and if it’s private/pre-IPO stock, it’s illiquid (you can’t easily rebalance or spend it). Worth a plan to diversify at a liquidity event.' : '. Worth diversifying over time so one position doesn’t dictate your net worth.'}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  bar: {
    flexDirection: 'row',
    height: 14,
    borderRadius: 6,
    overflow: 'hidden',
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
  },
  legend: { gap: 6 },
  legendRow: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 9, height: 9, borderRadius: 4.5, marginRight: spacing.sm },
  legendLabel: { fontSize: 13, fontWeight: '500', flex: 1, textTransform: 'capitalize' },
  legendPct: { fontSize: 13, fontWeight: '700', width: 46, textAlign: 'right' },
  legendVal: { ...typography.caption, fontSize: 12, width: 96, textAlign: 'right' },
  holdings: { marginTop: spacing.md, gap: spacing.sm },
  subhead: { ...typography.label, fontSize: 10, letterSpacing: 0.6, marginBottom: 2 },
  holdingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  holdingLeft: { flex: 1 },
  holdingName: { fontSize: 13, fontWeight: '600' },
  privateTag: { fontSize: 10, fontWeight: '500', fontStyle: 'italic' },
  holdingBarTrack: { height: 5, borderRadius: 3, marginTop: 4, overflow: 'hidden' },
  holdingBarFill: { height: 5, borderRadius: 3 },
  holdingRight: { alignItems: 'flex-end', width: 110 },
  holdingVal: { fontSize: 13, fontWeight: '600' },
  holdingPct: { ...typography.caption, fontSize: 11 },
  concBox: {
    marginTop: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.sm,
  },
  concTitle: { fontSize: 13, fontWeight: '700', marginBottom: 2 },
  concBody: { ...typography.caption, fontSize: 12, lineHeight: 17 },
});

const AssetMixCardMemo = React.memo(AssetMixCard);
export { AssetMixCardMemo as AssetMixCard };
