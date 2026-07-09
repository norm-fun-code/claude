import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, colors, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';

interface Idx {
  label: string;
  symbol: string;
  price: number;
  change: number;
  changePct: number;
}

const SYMBOLS = [
  { symbol: '^GSPC', label: 'S&P 500' },
  { symbol: '^IXIC', label: 'NASDAQ' },
];

// Before the 9:30am ET open, yesterday's index close is stale news — futures
// are what's actually moving. Same Yahoo endpoint, futures symbols.
const FUTURES = [
  { symbol: 'ES=F', label: 'S&P FUTURES' },
  { symbol: 'NQ=F', label: 'NASDAQ FUTURES' },
];

// True on weekday mornings before the 9:30am ET cash open (ET-anchored so it
// behaves correctly when traveling).
function isPreMarketET(): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const mins = Number(get('hour')) * 60 + Number(get('minute'));
  return mins < 9 * 60 + 30;
}

// Fetched from the device (not the server) — finance APIs block datacenter IPs
// like Railway's, but answer a phone's residential/cellular connection fine.
async function fetchIndex({ symbol, label }: { symbol: string; label: string }): Promise<Idx> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const res = await fetch(url);
  const json = await res.json();
  const meta = json?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  const prev = meta?.chartPreviousClose ?? meta?.previousClose;
  if (!Number.isFinite(price) || !Number.isFinite(prev)) throw new Error('no quote');
  const change = price - prev;
  return {
    label,
    symbol,
    price: Math.round(price * 100) / 100,
    change: Math.round(change * 100) / 100,
    changePct: Math.round((prev ? (change / prev) * 100 : 0) * 100) / 100,
  };
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function signed(n: number): string {
  return `${n > 0 ? '+' : ''}${fmt(n)}`;
}

// S&P 500 + NASDAQ day performance — a compact scoreboard above the news.
function IndicesCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [indices, setIndices] = useState<Idx[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const preMarket = isPreMarketET();
      const primary = preMarket ? FUTURES : SYMBOLS;
      let results = await Promise.allSettled(primary.map(fetchIndex));
      let quotes = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<Idx>).value);
      // Futures quotes can be unavailable (holiday halts, symbol hiccups) —
      // fall back to the index close rather than showing nothing.
      if (preMarket && quotes.length === 0) {
        results = await Promise.allSettled(SYMBOLS.map(fetchIndex));
        quotes = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<Idx>).value);
      }
      if (!cancelled) setIndices(quotes);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (indices.length === 0) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="📊" title="Today's Market" tint="gold" />
      <View style={styles.row}>
        {indices.map((idx) => {
          const up = idx.change >= 0;
          const tint = up ? colors.green : colors.red;
          return (
            <View key={idx.symbol} style={[styles.cell, { borderColor: c.border }]}>
              <Text style={[styles.label, { color: c.subtext }]}>{idx.label}</Text>
              <Text style={[styles.price, { color: c.text }]}>{fmt(idx.price)}</Text>
              <View style={[styles.pill, { backgroundColor: tint + '1A' }]}>
                <Text style={[styles.change, { color: tint }]}>
                  {up ? '▲' : '▼'} {signed(idx.changePct)}%
                </Text>
              </View>
              <Text style={[styles.changeAbs, { color: c.subtext }]}>{signed(idx.change)} pts</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
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

const IndicesCardMemo = React.memo(IndicesCard);
export { IndicesCardMemo as IndicesCard };
