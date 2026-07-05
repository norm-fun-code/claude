import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Pressable, useColorScheme, Animated, PanResponder, LayoutAnimation,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { SectionHeader } from './SectionHeader';
import { getColors, spacing, radius, typography, shadow, withAlpha } from '../theme';
import { RECOMMENDATIONS_URL, authHeaders, fetchWithTimeout } from '../config';

type Rec = {
  id: number;
  title: string;
  created_at: string;
  outcome_delta: number | null;
  outcome_measured_at: string | null;
  outcome_metric: string | null;
  expected_direction: 'up' | 'down' | null;
  surfaced_in: string;
  // Set when this rec auto-created a linked commitment (see backend
  // recordRecommendation) — lets the card tell "this resolves itself when
  // you finish the Today task" apart from "this is waiting on your rating."
  commitment_status: 'open' | 'done' | 'skipped' | 'expired' | null;
  commitment_due_at: string | null;
};

type Stats = { total: number; measured: number; positive: number; hitRate: number | null };

function relDays(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d === 0 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`;
}

function dueLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.ceil((d.getTime() - Date.now()) / 86400000);
  if (days <= 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return `due in ${days}d`;
}

// One of four states, each meaning something distinct about WHO acts next and
// WHERE — this is the whole point of the redesign: every row states its own
// mechanism in plain words instead of leaving you to infer it from a chip.
type Status = {
  kind: 'resolved' | 'auto-metric' | 'auto-commitment' | 'needs-rating';
  chipLabel: string;
  chipColor: string;
  chipBg: string;
  icon: keyof typeof Ionicons.glyphMap;
  caption: string; // the per-row explainer — the actual fix for "how do I use this?"
};

function getStatus(
  rec: Rec,
  c: ReturnType<typeof getColors>,
  localMeasuredAt?: string | null,
  localDelta?: number | null,
): Status {
  const measuredAt = localMeasuredAt !== undefined ? localMeasuredAt : rec.outcome_measured_at;
  const delta = localDelta !== undefined ? localDelta : rec.outcome_delta;

  if (measuredAt) {
    if (delta == null) {
      return { kind: 'resolved', chipLabel: 'No data', chipColor: c.subtext, chipBg: c.border, icon: 'help-circle-outline', caption: 'Could not be measured' };
    }
    // No tracked metric → resolved by a linked commitment's done/skipped, not
    // a measured data delta. "Worked/No effect" would misleadingly imply we
    // checked the data; we only know whether you did it.
    if (!rec.outcome_metric) {
      return delta > 0
        ? { kind: 'resolved', chipLabel: 'Done', chipColor: '#2E7D32', chipBg: withAlpha('#2E7D32', 0.14), icon: 'checkmark-circle', caption: 'You marked it done' }
        : { kind: 'resolved', chipLabel: 'Skipped', chipColor: c.subtext, chipBg: c.border, icon: 'close-circle', caption: 'You skipped it' };
    }
    const hit = rec.expected_direction === 'down' ? delta < 0 : delta > 0;
    return hit
      ? { kind: 'resolved', chipLabel: 'Worked', chipColor: '#2E7D32', chipBg: withAlpha('#2E7D32', 0.14), icon: 'checkmark-circle', caption: 'Confirmed by your own data' }
      : { kind: 'resolved', chipLabel: 'No effect', chipColor: c.subtext, chipBg: c.border, icon: 'close-circle', caption: 'Your data showed no effect' };
  }

  // Not yet resolved — three distinct mechanisms:
  if (rec.outcome_metric) {
    return {
      kind: 'auto-metric',
      chipLabel: 'Tracking',
      chipColor: c.accent,
      chipBg: withAlpha(c.accent, 0.12),
      icon: 'analytics-outline',
      caption: 'Auto-checking your data in about a week',
    };
  }
  if (rec.commitment_status === 'open') {
    const due = dueLabel(rec.commitment_due_at);
    return {
      kind: 'auto-commitment',
      chipLabel: 'On Today',
      chipColor: '#A78BFA',
      chipBg: withAlpha('#A78BFA', 0.16),
      icon: 'checkbox-outline',
      caption: due ? `Resolves when you finish it on Today — ${due}` : 'Resolves when you finish it on Today',
    };
  }
  // No metric, no (or no longer open) linked commitment — the one state where
  // this CARD is the only place to close the loop.
  return {
    kind: 'needs-rating',
    chipLabel: 'Rate it',
    chipColor: '#B8860B',
    chipBg: withAlpha('#FF9F0A', 0.16),
    icon: 'hand-left-outline',
    caption: 'No automatic check for this one — rate it below',
  };
}

function SwipeableRow({
  rec, c, onDelete,
}: { rec: Rec; c: ReturnType<typeof getColors>; onDelete: (id: number) => void }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const [deleting, setDeleting] = useState(false);
  const [localMeasuredAt, setLocalMeasuredAt] = useState<string | null | undefined>(undefined);
  const [localDelta, setLocalDelta] = useState<number | null | undefined>(undefined);
  // Most titles are short and formulaic (the leverage engine's templates), but a
  // freeform Ask-sourced one can run long — tap to unfold instead of silently
  // losing the rest of the sentence behind an ellipsis with no way to read it.
  const [expanded, setExpanded] = useState(false);
  function toggleExpanded() {
    LayoutAnimation.configureNext(LayoutAnimation.create(200, 'easeInEaseOut', 'opacity'));
    setExpanded((v) => !v);
  }

  const SWIPE_THRESHOLD = 80;

  const panResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
    onPanResponderMove: (_, g) => {
      if (g.dx < 0) translateX.setValue(g.dx);
    },
    onPanResponderRelease: (_, g) => {
      if (g.dx < -SWIPE_THRESHOLD) {
        Animated.timing(translateX, { toValue: -400, duration: 200, useNativeDriver: true }).start(() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
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

  async function markOutcome(thumbsUp: boolean) {
    const expectedDir = rec.expected_direction;
    const delta = thumbsUp
      ? (expectedDir === 'down' ? -1 : 1)
      : (expectedDir === 'down' ? 1 : -1);
    const measuredAt = new Date().toISOString();
    setLocalMeasuredAt(measuredAt);
    setLocalDelta(delta);
    try {
      await fetchWithTimeout(`${RECOMMENDATIONS_URL}/${rec.id}/outcome`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ thumbsUp }),
      });
      Haptics.selectionAsync();
    } catch {
      setLocalMeasuredAt(undefined);
      setLocalDelta(undefined);
    }
  }

  if (deleting) return null;

  const status = getStatus(rec, c, localMeasuredAt, localDelta);
  const source = rec.surfaced_in === 'briefing' ? 'morning brief'
    : rec.surfaced_in === 'chat' ? 'Ask' : rec.surfaced_in;
  const resolved = status.kind === 'resolved';
  // The primary, unmissable action row — only when THIS card is genuinely the
  // one place left to close the loop. The other two unresolved states get a
  // small, muted "rate it anyway" escape hatch instead, so the strong visual
  // treatment stays reserved for when it's actually needed.
  const isPrimaryAction = status.kind === 'needs-rating';

  return (
    <View style={{ overflow: 'hidden' }}>
      {/* Red delete background revealed on swipe */}
      <View style={[styles.deleteHint, { backgroundColor: '#FF3B30' }]}>
        <Text style={styles.deleteHintText}>Delete</Text>
      </View>
      <Animated.View
        style={[
          styles.row,
          { borderTopColor: c.border, backgroundColor: c.card, transform: [{ translateX }] },
          resolved && styles.rowResolved,
        ]}
        {...panResponder.panHandlers}
      >
        <View style={styles.rowTop}>
          <Pressable style={styles.titleWrap} onPress={toggleExpanded} disabled={rec.title.length < 80}>
            <Text
              style={[styles.recTitle, { color: c.text }, resolved && { color: c.subtext }]}
              numberOfLines={expanded ? undefined : 2}
            >
              {rec.title}
            </Text>
          </Pressable>
          <View style={[styles.chip, { backgroundColor: status.chipBg }]}>
            <Ionicons name={status.icon} size={12} color={status.chipColor} />
            <Text style={[styles.chipText, { color: status.chipColor }]}>{status.chipLabel}</Text>
          </View>
        </View>

        <Text style={[styles.caption, { color: c.subtext }, resolved && styles.captionResolved]}>
          {status.caption}
        </Text>
        <Text style={[styles.recMeta, { color: c.subtext }]}>{relDays(rec.created_at)} · {source}</Text>

        {!resolved && (
          isPrimaryAction ? (
            <View style={styles.actionsPrimary}>
              <TouchableOpacity
                onPress={() => { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); markOutcome(true); }}
                hitSlop={6}
                style={[styles.actionBtn, styles.actionBtnUp]}
                accessibilityLabel="It helped"
              >
                <Ionicons name="thumbs-up" size={15} color="#fff" />
                <Text style={styles.actionBtnText}>Helped</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); markOutcome(false); }}
                hitSlop={6}
                style={[styles.actionBtn, { borderColor: c.border, borderWidth: 1 }]}
                accessibilityLabel="Didn't help"
              >
                <Ionicons name="thumbs-down-outline" size={15} color={c.subtext} />
                <Text style={[styles.actionBtnText, { color: c.subtext }]}>Didn't help</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.actionsSecondary}>
              <TouchableOpacity onPress={() => markOutcome(true)} hitSlop={8} style={styles.miniBtn}>
                <Ionicons name="thumbs-up-outline" size={13} color={c.subtext} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => markOutcome(false)} hitSlop={8} style={styles.miniBtn}>
                <Ionicons name="thumbs-down-outline" size={13} color={c.subtext} />
              </TouchableOpacity>
              <Text style={[styles.miniHint, { color: c.subtext }]}>already know? rate it</Text>
            </View>
          )
        )}
      </Animated.View>
    </View>
  );
}

const LEGEND: { icon: keyof typeof Ionicons.glyphMap; color: string; label: string }[] = [
  { icon: 'hand-left-outline', color: '#B8860B', label: 'Rate it — needs you' },
  { icon: 'checkbox-outline', color: '#A78BFA', label: 'Resolves on Today' },
  { icon: 'analytics-outline', color: '#635BFF', label: 'Auto-tracking' },
  { icon: 'checkmark-circle', color: '#2E7D32', label: 'Resolved' },
];

export function RecommendationLedgerCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

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
        <View style={styles.titleRow}>
          <SectionHeader emoji="📋" title="Recommendation Ledger" preserveCase />
          <TouchableOpacity onPress={() => setShowInfo((v) => !v)} hitSlop={8} style={styles.infoBtn}>
            <Text style={[styles.infoToggle, { color: c.accent }]}>{showInfo ? 'Hide' : "What's this?"}</Text>
          </TouchableOpacity>
        </View>
        {stats && (
          <Text style={[styles.statsText, { color: c.subtext }]}>
            {stats.total} made{stats.hitRate != null ? ` · ${Math.round(stats.hitRate)}% effective` : ''}
          </Text>
        )}
        {showInfo ? (
          <View style={[styles.infoBox, { backgroundColor: c.border + '55' }]}>
            <Text style={[styles.infoText, { color: c.text }]}>
              Every action NormOS suggests — in your morning brief or in Ask — lands here. Each one shows exactly
              how it gets resolved: some check your own data automatically, some resolve when you finish a linked
              task on Today, and a few genuinely need your thumb. Swipe left to dismiss any of them.
            </Text>
            <View style={styles.legend}>
              {LEGEND.map((l) => (
                <View key={l.label} style={styles.legendRow}>
                  <Ionicons name={l.icon} size={13} color={l.color} />
                  <Text style={[styles.legendText, { color: c.text }]}>{l.label}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : (
          <Text style={[styles.hint, { color: c.subtext }]}>Every card explains how it resolves — swipe left to dismiss</Text>
        )}
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
  card: { borderRadius: radius.xl, padding: spacing.lg, marginBottom: spacing.md },
  header: { marginBottom: spacing.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  infoBtn: { paddingVertical: 2, paddingLeft: spacing.sm },
  infoToggle: { fontSize: 12, fontWeight: '600' },
  infoBox: { borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.xs },
  infoText: { fontSize: 12, lineHeight: 17 },
  legend: { marginTop: spacing.sm, gap: 6 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  legendText: { fontSize: 12, fontWeight: '500' },
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
    borderTopWidth: 1,
    paddingTop: spacing.md,
    marginTop: spacing.sm,
    paddingBottom: 2,
    gap: 5,
  },
  rowResolved: { opacity: 0.6 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  titleWrap: { flex: 1 },
  recTitle: { fontSize: 14, fontWeight: '600', lineHeight: 19 },
  caption: { fontSize: 12, lineHeight: 16, fontStyle: 'italic' },
  captionResolved: { fontStyle: 'normal' },
  recMeta: { ...typography.caption, fontSize: 11 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 4,
    flexShrink: 0,
  },
  chipText: { fontSize: 11, fontWeight: '700' },
  actionsPrimary: { flexDirection: 'row', gap: spacing.sm, marginTop: 4 },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.pill,
  },
  actionBtnUp: { backgroundColor: '#2E7D32' },
  actionBtnText: { fontSize: 12, fontWeight: '700', color: '#fff' },
  actionsSecondary: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 2 },
  miniBtn: { padding: 2 },
  miniHint: { fontSize: 11, fontStyle: 'italic', marginLeft: 2 },
  toggle: { marginTop: spacing.sm, alignItems: 'center' },
  toggleText: { fontSize: 13, fontWeight: '600' },
});
