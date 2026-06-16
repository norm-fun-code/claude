import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme, ActivityIndicator } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { MARKETS_REFRESH_URL, authHeaders, fetchWithTimeout } from '../config';
import type { Markets } from '../hooks/useBriefing';

interface Props {
  markets: Markets | null | undefined;
}

// Claude-written daily market brief (3-5 bullets) from live finance feeds.
export function MarketsCard({ markets: initialMarkets }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [markets, setMarkets] = useState(initialMarkets);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  // Sync with briefing prop updates (e.g. after full rebuild) unless the user
  // has already done a manual refresh — in that case, keep the fresher local copy.
  useEffect(() => {
    if (!refreshedAt) setMarkets(initialMarkets);
  }, [initialMarkets, refreshedAt]);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await fetchWithTimeout(
        MARKETS_REFRESH_URL,
        { method: 'POST', headers: authHeaders() },
        45000
      );
      if (res.ok) {
        const json = await res.json();
        if (json.markets) {
          setMarkets(json.markets);
          setRefreshedAt(new Date());
        }
      }
    } catch {
      // best-effort — leave existing brief in place
    } finally {
      setRefreshing(false);
    }
  };

  const brief = markets?.brief;

  if (!brief && !refreshing) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, shadow(isDark)]}>
      <View style={styles.headerRow}>
        <SectionHeader emoji="📰" title="Market Brief" />
        <TouchableOpacity onPress={handleRefresh} disabled={refreshing} style={styles.refreshBtn}>
          {refreshing ? (
            <ActivityIndicator size="small" color={c.subtext} />
          ) : (
            <Text style={[styles.refreshText, { color: c.accent }]}>↻ Refresh</Text>
          )}
        </TouchableOpacity>
      </View>

      {refreshedAt && (
        <Text style={[styles.refreshedAt, { color: c.subtext }]}>
          Updated {refreshedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </Text>
      )}

      {brief ? <Markdown style={markdownStyles(c)}>{brief}</Markdown> : null}
    </View>
  );
}

function markdownStyles(c: ReturnType<typeof getColors>) {
  return {
    body: { color: c.text, fontSize: 15, lineHeight: 22 },
    bullet_list: { marginVertical: 2 },
    list_item: { marginVertical: 3 },
    strong: { fontWeight: '700', color: c.text },
    paragraph: { marginTop: 0, marginBottom: 6 },
  } as any;
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  refreshBtn: {
    minWidth: 28,
    alignItems: 'flex-end',
    marginBottom: spacing.sm,
    marginTop: 2,
  },
  refreshText: { fontSize: 12, fontWeight: '600' },
  refreshedAt: { ...typography.caption, marginBottom: spacing.xs, marginTop: -spacing.xs },
});
