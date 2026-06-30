import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { spacing, radius, typography, glow, bandGradient } from '../theme';
import type { EveningBrief, EveningTone } from '../hooks/useEveningBrief';

interface Props {
  brief: EveningBrief | null | undefined;
}

// Autonomic tone → the same band language the recovery orb uses, so green/amber/red
// reads consistently across the app. Settled=green, mild=amber, elevated=red.
const TONE_BAND: Record<EveningTone, keyof typeof bandGradient> = {
  settled: 'green',
  mild: 'yellow',
  elevated: 'red',
  unknown: 'neutral',
};

const BLOCKS: { key: keyof Pick<EveningBrief, 'today' | 'tomorrow' | 'habits'>; label: string }[] = [
  { key: 'today', label: 'TODAY' },
  { key: 'tomorrow', label: 'SET UP TOMORROW' },
  { key: 'habits', label: 'STILL OPEN' },
];

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipValue}>{value}</Text>
      <Text style={styles.chipLabel}>{label}</Text>
    </View>
  );
}

export function EveningBriefCard({ brief }: Props) {
  if (!brief || !brief.headline) return null;
  const band = TONE_BAND[brief.tone] || 'neutral';
  const [g1, g2] = bandGradient[band];
  const s = brief.signals || ({} as EveningBrief['signals']);

  const chips: { label: string; value: string }[] = [];
  if (s.hrv != null) chips.push({ label: s.hrvBaseline != null ? `HRV · norm ${Math.round(s.hrvBaseline)}` : 'HRV', value: `${Math.round(s.hrv)}ms` });
  if (s.rhr != null) chips.push({ label: s.rhrBaseline != null ? `RHR · norm ${Math.round(s.rhrBaseline)}` : 'RHR', value: `${Math.round(s.rhr)}` });
  if (s.steps != null) chips.push({ label: 'steps', value: Math.round(s.steps).toLocaleString() });

  return (
    <View style={[styles.card, glow(g1, 0.2, 24)]}>
      <LinearGradient colors={['#23232E', '#161619']} start={{ x: 0, y: 0 }} end={{ x: 0.7, y: 1 }} style={styles.gradient} />
      <LinearGradient colors={[g1, g2]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.accentBar} />

      <Text style={styles.kicker}>EVENING · WIND DOWN</Text>

      {/* No internal entrance animation: this card loads async and inserts at the
          top of the feed, so per-line springs cascading WHILE the layout shifts
          read as a shake/glitch. It renders statically and fades in as one unit
          (the outer wrapper in App.tsx handles a single opacity fade). */}
      <Text style={styles.headline}>{brief.headline}</Text>
      <Text style={styles.readiness}>{brief.readiness}</Text>

      {chips.length > 0 && (
        <View style={styles.chipRow}>
          {chips.map((ch) => (
            <Chip key={ch.label} label={ch.label} value={ch.value} />
          ))}
        </View>
      )}

      <View style={styles.separator} />

      {BLOCKS.filter(({ key }) => (brief[key] || '').trim()).map(({ key, label }) => (
        <View key={key} style={styles.block}>
          <Text style={styles.blockLabel}>{label}</Text>
          <Text style={styles.blockText}>{brief[key]}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    padding: spacing.lg,
    marginBottom: spacing.md,
    overflow: 'hidden',
    backgroundColor: '#1A1A1E',
  },
  gradient: { ...StyleSheet.absoluteFillObject },
  accentBar: { width: 44, height: 3, borderRadius: 2, marginBottom: spacing.sm },
  kicker: { fontSize: 10, fontWeight: '700', letterSpacing: 1.4, color: 'rgba(255,255,255,0.55)', marginBottom: spacing.sm },
  headline: { fontSize: 20, fontWeight: '700', color: '#fff', letterSpacing: -0.3, marginBottom: spacing.sm, lineHeight: 27 },
  readiness: { fontSize: 15, fontWeight: '400', color: 'rgba(255,255,255,0.92)', lineHeight: 24, marginBottom: spacing.md },
  chipRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md, flexWrap: 'wrap' },
  chip: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minWidth: 64,
  },
  chipValue: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  chipLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 10, fontWeight: '600', marginTop: 2, letterSpacing: 0.3 },
  separator: { height: 1, backgroundColor: 'rgba(255,255,255,0.12)', marginBottom: spacing.md },
  block: { marginBottom: spacing.sm + 2 },
  blockLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1.0, color: 'rgba(255,255,255,0.55)', marginBottom: 4 },
  blockText: { ...typography.body, color: '#fff', fontSize: 14, lineHeight: 22 },
});
