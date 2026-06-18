import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, useColorScheme,
} from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { RECOMMENDATIONS_URL, authHeaders, fetchWithTimeout } from '../config';

type Rec = {
  id: number;
  title: string;
  created_at: string;
  outcome_delta: number | null;
  outcome_measured_at: string | null;
  expected_direction: 'up' | 'down' | null;
  surfaced_in: string;
};

type Stats = { total: number; measured: number; positive: number; hitRate: number | null };

function relDays(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d === 0 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`;
}

function outcomeChip(rec: Rec, c: ReturnType<typeof getColors>) {
  if (!rec.outcome_measured_at) return { label: 'Pending', color: c.subtext, bg: c.border };
  if (rec.outcome_delta == null) return { label: 'No data', color: c.subtext, bg: c.border };
  const hit =
    rec.expected_direction === 'up' ? rec.outcome_delta > 0 :
    rec.expected_direction === 'down' ? rec.outcome_delta < 0: false;
  return hit
    ? { label: 'Worked ↑', color: '#2E7D32', bg: '#E8F5E9' }
    : { label: 'No effect', color: '#9E9E9E', bg: c.border };
}

export function RecommendationLedgerCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchWithTimeout(`${RECOMMENDATIONS_URL}?limit=20`, { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        setRecs(data.recommendations ?? []);
        setStats(data.stats ?? null);
      } catch {}
    })();
  }, []);

  if (recs.length === 0) return null;

  const visible = showAll ? recs : recs.slice(0, 5);

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: c.text }]}>Recommendation Ledger</Text>
        {stats && (
          <Text style={[styles.statsText, { color: c.subtext }]}>
            {stats.total} made{stats.hitRate != null ? ` · ${Math.round(stats.hitRate)}% effective` : ''}
          </Text>
        )}
      </View>

      {visible.map((rec) => {
        const chip = outcomeChip(rec, c);
        const source = rec.surfaced_in === 'briefing' ? 'morning brief'
          : rec.surfaced_in === 'chat' ? 'Ask' : rec.surfaced_in;
        return (
          <View key={rec.id} style={[styles.row, { borderTopColor: c.border }]}>
            <View style={styles.rowMain}>
              <Text style={[styles.recTitle, { color: c.text }]} numberOfLines={2}>
                {rec.title}
              </Text>
              <Text style={[styles.recMeta, { color: c.subtext }]}>
                {relDays(rec.created_at)} · {source}
              </Text>
            </View>
            <View style={[styles.chip, { backgroundColor: chip.bg }]}>
              <Text style={[styles.chipText, { color: chip.color }]}>{chip.label}</Text>
            </View>
          </View>
        );
      })}

      {recs.length > 5 && (
        <TouchableOpacity onPress={() => setShowAll((v) => !v)} style={styles.toggle} hitSlop={8}>
          <Text style={[styles.toggleText, { color: c.accent }]}>
            {showAll ? 'Show less' : `Show ${recs.length - 5} more`}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  header: { marginBottom: spacing.sm },
  title: { fontSize: 16, fontWeight: '700', marginBottom: 2 },
  statsText: { ...typography.caption, fontSize: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    paddingTop: spacing.sm,
    marginTop: spacing.xs,
    gap: spacing.sm,
  },
  rowMain: { flex: 1 },
  recTitle: { fontSize: 13, fontWeight: '500', lineHeight: 18, marginBottom: 2 },
  recMeta: { ...typography.caption, fontSize: 11 },
  chip: {
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
    flexShrink: 0,
  },
  chipText: { fontSize: 11, fontWeight: '700' },
  toggle: { marginTop: spacing.sm, alignItems: 'center' },
  toggleText: { fontSize: 13, fontWeight: '600' },
});
