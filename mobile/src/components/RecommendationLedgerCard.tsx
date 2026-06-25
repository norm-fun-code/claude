import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, useColorScheme, Animated, PanResponder,
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
    rec.expected_direction === 'down' ? rec.outcome_delta < 0 : false;
  return hit
    ? { label: 'Worked ↑', color: '#2E7D32', bg: '#E8F5E9' }
    : { label: 'No effect', color: '#9E9E9E', bg: c.border };
}

function SwipeableRow({
  rec, c, onDelete,
}: { rec: Rec; c: ReturnType<typeof getColors>; onDelete: (id: number) => void }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const rowHeight = useRef(new Animated.Value(1)).current; // used as scale for collapse
  const [deleting, setDeleting] = useState(false);

  const SWIPE_THRESHOLD = 80;

  const panResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
    onPanResponderMove: (_, g) => {
      if (g.dx < 0) translateX.setValue(g.dx);
    },
    onPanResponderRelease: (_, g) => {
      if (g.dx < -SWIPE_THRESHOLD) {
        // Swipe far enough — animate out then delete
        Animated.timing(translateX, { toValue: -400, duration: 200, useNativeDriver: true }).start(() => {
          setDeleting(true);
          fetchWithTimeout(`${RECOMMENDATIONS_URL}/${rec.id}`, {
            method: 'DELETE', headers: authHeaders(),
          }).catch(() => {}).finally(() => onDelete(rec.id));
        });
      } else {
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
      }
    },
  })).current;

  if (deleting) return null;

  const chip = outcomeChip(rec, c);
  const source = rec.surfaced_in === 'briefing' ? 'morning brief'
    : rec.surfaced_in === 'chat' ? 'Ask' : rec.surfaced_in;

  return (
    <View style={{ overflow: 'hidden' }}>
      {/* Red delete background revealed on swipe */}
      <View style={[styles.deleteHint, { backgroundColor: '#FF3B30' }]}>
        <Text style={styles.deleteHintText}>Delete</Text>
      </View>
      <Animated.View
        style={[styles.row, { borderTopColor: c.border, backgroundColor: c.card, transform: [{ translateX }] }]}
        {...panResponder.panHandlers}
      >
        <View style={styles.rowMain}>
          <Text style={[styles.recTitle, { color: c.text }]} numberOfLines={2}>{rec.title}</Text>
          <Text style={[styles.recMeta, { color: c.subtext }]}>{relDays(rec.created_at)} · {source}</Text>
        </View>
        <View style={[styles.chip, { backgroundColor: chip.bg }]}>
          <Text style={[styles.chipText, { color: chip.color }]}>{chip.label}</Text>
        </View>
      </Animated.View>
    </View>
  );
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

  const handleDelete = (id: number) => setRecs((prev) => prev.filter((r) => r.id !== id));

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
        <Text style={[styles.hint, { color: c.subtext }]}>Swipe left to dismiss</Text>
      </View>

      {visible.map((rec) => (
        <SwipeableRow key={rec.id} rec={rec} c={c} onDelete={handleDelete} />
      ))}

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
  hint: { ...typography.caption, fontSize: 11, marginTop: 2 },
  deleteHint: {
    position: 'absolute', right: 0, top: 0, bottom: 0,
    justifyContent: 'center', alignItems: 'flex-end',
    paddingRight: spacing.md, borderRadius: radius.sm,
    minWidth: 80,
  },
  deleteHintText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    paddingTop: spacing.sm,
    marginTop: spacing.xs,
    gap: spacing.sm,
    paddingVertical: spacing.sm,
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
