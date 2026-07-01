import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius } from '../theme';
import { SOURCES_FRESHNESS_URL, authHeaders, fetchWithTimeout } from '../config';

interface Source { source: string; label: string; date: string; ageDays: number }

function status(ageDays: number): string {
  if (ageDays <= 0) return 'today';
  if (ageDays === 1) return 'yesterday';
  return `${ageDays}d behind`;
}

// Per-source data freshness — "Eight Sleep · last night", "Finances · 3d behind".
// Subtle when everything's current; amber/red when a source has gone stale, so a
// missed sync is visible rather than silently skewing the day's numbers.
export function DataFreshnessBar({ version = 0 }: { version?: number }) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [sources, setSources] = useState<Source[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTimeout(SOURCES_FRESHNESS_URL, { headers: authHeaders() });
        if (cancelled || !res.ok) return;
        const { sources: s } = await res.json();
        if (!cancelled) setSources(s ?? []);
      } catch { /* offline — hide */ }
    })();
    return () => { cancelled = true; };
  }, [version]);

  if (!sources.length) return null;

  return (
    <View style={styles.row}>
      {sources.map((s) => {
        const stale = s.ageDays >= 3 ? c.red : s.ageDays === 2 ? c.yellow : c.subtext;
        return (
          <View key={s.source} style={styles.item}>
            <View style={[styles.dot, { backgroundColor: stale }]} />
            <Text style={[styles.txt, { color: c.subtext }]} numberOfLines={1}>
              {s.label} · <Text style={{ color: stale, fontWeight: s.ageDays >= 2 ? '700' : '500' }}>{status(s.ageDays)}</Text>
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, paddingHorizontal: spacing.xs, marginBottom: spacing.sm },
  item: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  txt: { fontSize: 11, fontWeight: '500' },
});
