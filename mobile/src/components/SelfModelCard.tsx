import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  useColorScheme,
} from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { CONSOLIDATE_URL, authHeaders, fetchWithTimeout } from '../config';

interface Snapshot {
  wellbeing?: Record<string, { cur: number | null; prior: number | null }>;
  health?: Record<string, { cur: number | null; prior: number | null; goodWhen?: string }>;
  habits?: Record<string, { rate: number | null; label: string; scale?: number }>;
  wealth?: { netWorth: number | null; spendingMtd: number | null };
  goals?: number;
  experiments?: { completed: unknown[]; running: unknown[] };
  findings?: number;
}

interface SelfModel {
  content: string;
  generatedAt: string;
  kind: string;
  snapshot: Snapshot;
}

function ageLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 2) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function habitBar(rate: number, c: ReturnType<typeof getColors>): string {
  const filled = Math.round(rate / 100 * 7);
  return '█'.repeat(filled) + '░'.repeat(7 - filled);
}

export function SelfModelCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [model, setModel] = useState<SelfModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithTimeout(CONSOLIDATE_URL, { headers: authHeaders() }, 15000);
      if (res.ok) {
        const json = await res.json();
        setModel({ content: json.content, generatedAt: json.generatedAt, kind: json.kind, snapshot: json.snapshot ?? {} });
      }
    } catch { /* best-effort */ } finally {
      setLoading(false);
    }
  }, []);

  const triggerConsolidate = useCallback(async () => {
    setConsolidating(true);
    try {
      const res = await fetchWithTimeout(CONSOLIDATE_URL, { method: 'POST', headers: authHeaders() }, 30000);
      if (res.ok) await load();
    } catch { /* best-effort */ } finally {
      setConsolidating(false);
    }
  }, [load]);

  useEffect(() => { load(); }, [load]);

  const s = model?.snapshot ?? {};
  const habits = s.habits ? Object.values(s.habits).filter((h) => h.rate != null) : [];
  const confirmedCount = s.findings ?? 0;
  const runningCount = s.experiments?.running?.length ?? 0;
  const completedCount = s.experiments?.completed?.length ?? 0;

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <View style={styles.headerRow}>
        <SectionHeader emoji="🧬" title="NormOS Profile" preserveCase />
        {model && (
          <Text style={[styles.age, { color: c.subtext }]}>Updated {ageLabel(model.generatedAt)}</Text>
        )}
      </View>

      {loading && !model && (
        <ActivityIndicator color={c.accent} style={{ marginTop: spacing.sm }} />
      )}

      {model && (
        <>
          {/* Stats strip — only shown when something is actually active */}
          {(confirmedCount + runningCount + completedCount + (s.goals ?? 0)) > 0 && (
            <View style={[styles.stats, { borderColor: c.border }]}>
              <Stat label="CONFIRMED" value={String(confirmedCount)} sub="correlations" c={c} />
              <View style={[styles.statDivider, { backgroundColor: c.border }]} />
              <Stat label="RUNNING" value={String(runningCount)} sub="experiments" c={c} />
              <View style={[styles.statDivider, { backgroundColor: c.border }]} />
              <Stat label="COMPLETED" value={String(completedCount)} sub="experiments" c={c} />
              <View style={[styles.statDivider, { backgroundColor: c.border }]} />
              <Stat label="GOALS" value={String(s.goals ?? 0)} sub="active" c={c} />
            </View>
          )}

          {/* Habits this week */}
          {habits.length > 0 && (
            <View style={[styles.section, { borderTopColor: c.border }]}>
              <Text style={[styles.sectionLabel, { color: c.subtext }]}>HABITS THIS WEEK</Text>
              {habits.map((h, i) => (
                <View key={i} style={styles.habitRow}>
                  <Text style={[styles.habitLabel, { color: c.text }]}>{h.label}</Text>
                  {h.scale === 5 ? (
                    <Text style={[styles.habitBar, { color: c.accent }]}>{h.rate}/5</Text>
                  ) : (
                    <Text style={[styles.habitBar, { color: (h.rate ?? 0) >= 80 ? c.green : (h.rate ?? 0) < 50 ? c.red : c.yellow }]}>
                      {habitBar(h.rate ?? 0, c)} {Math.round((h.rate ?? 0) / 100 * 7)}/7
                    </Text>
                  )}
                </View>
              ))}
            </View>
          )}

          {/* Full model text toggle */}
          <View style={[styles.section, { borderTopColor: c.border }]}>
            <TouchableOpacity onPress={() => setExpanded((e) => !e)} activeOpacity={0.7} style={styles.toggleRow}>
              <Text style={[styles.sectionLabel, { color: c.subtext }]}>FULL MODEL TEXT</Text>
              <Text style={[styles.toggleChevron, { color: c.subtext }]}>{expanded ? '▲' : '▼'}</Text>
            </TouchableOpacity>
            {expanded && (
              <ScrollView style={[styles.modelScroll, { backgroundColor: c.accentSoft, borderRadius: radius.sm }]} nestedScrollEnabled>
                <Text style={[styles.modelText, { color: c.text }]}>{model.content}</Text>
              </ScrollView>
            )}
          </View>
        </>
      )}

      {/* Re-consolidate button */}
      <TouchableOpacity
        onPress={triggerConsolidate}
        disabled={consolidating || loading}
        style={[styles.btn, { borderColor: c.border, backgroundColor: c.accentSoft }]}
        activeOpacity={0.7}
      >
        {consolidating ? (
          <ActivityIndicator size="small" color={c.accent} />
        ) : (
          <Text style={[styles.btnText, { color: c.accent }]}>↺ Re-consolidate profile</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

function Stat({ label, value, sub, c }: { label: string; value: string; sub: string; c: ReturnType<typeof getColors> }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: c.subtext }]}>{label}</Text>
      <Text style={[styles.statValue, { color: c.text }]}>{value}</Text>
      <Text style={[styles.statSub, { color: c.subtext }]}>{sub}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  age: { fontSize: 11, fontWeight: '500' },
  stats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
    borderTopWidth: 1,
  },
  stat: { flex: 1, alignItems: 'center' },
  statDivider: { width: 1, marginVertical: 2 },
  statLabel: { fontSize: 8, fontWeight: '700', letterSpacing: 0.6, marginBottom: 2 },
  statValue: { fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  statSub: { fontSize: 9, fontWeight: '500' },
  section: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
  },
  sectionLabel: {
    ...typography.label,
    fontSize: 9,
    marginBottom: spacing.xs,
  },
  habitRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  habitLabel: { fontSize: 13, fontWeight: '500', flex: 1 },
  habitBar: { fontSize: 11, fontFamily: 'Courier', fontWeight: '400', letterSpacing: -1 },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  toggleChevron: { fontSize: 11 },
  modelScroll: { maxHeight: 220, padding: spacing.sm },
  modelText: { fontSize: 12, lineHeight: 18, fontFamily: 'Courier' },
  btn: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  btnText: { fontSize: 13, fontWeight: '600' },
});
