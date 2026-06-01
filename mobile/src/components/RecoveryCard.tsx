import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, colors } from '../theme';
import { SectionHeader } from './SectionHeader';
import type { Recovery, HealthComposite } from '../hooks/useBriefing';

interface Props {
  recovery: Recovery | null | undefined;
  composites?: HealthComposite[];
}

const PART_LABEL: Record<string, string> = {
  hrv: 'HRV',
  restingHr: 'Resting HR',
  sleep: 'Sleep',
};

const COMPOSITE_EMOJI: Record<string, string> = {
  sleep_debt: '🛌',
  sleep_consistency: '🌙',
  training_load: '🏋️',
};

// The headline "how recovered am I" number — a composite of HRV, resting HR, and
// sleep, each graded against the user's OWN baseline (Whoop/Oura-style). Shown as
// a colored ring with the contributing parts and any sleep-debt / training-load
// flags beneath.
export function RecoveryCard({ recovery, composites = [] }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!recovery || recovery.score == null) return null;

  const bandColor =
    recovery.band === 'green' ? colors.green : recovery.band === 'yellow' ? colors.yellow : colors.red;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="🔋" title="Recovery" />

      <View style={styles.scoreRow}>
        <View style={[styles.ring, { borderColor: bandColor }]}>
          <Text style={[styles.score, { color: c.text }]}>{recovery.score}</Text>
          <Text style={[styles.scoreUnit, { color: c.subtext }]}>/ 100</Text>
        </View>
        <View style={styles.scoreMeta}>
          <Text style={[styles.band, { color: bandColor }]}>
            {recovery.band === 'green' ? 'Recovered' : recovery.band === 'yellow' ? 'Moderate' : 'Low'}
          </Text>
          {recovery.detail ? (
            <Text style={[styles.detail, { color: c.subtext }]} numberOfLines={3}>
              {recovery.detail}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Contributing parts (each a percentile of your own baseline) */}
      {Object.keys(recovery.parts || {}).length > 0 && (
        <View style={[styles.parts, { borderTopColor: c.border }]}>
          {Object.entries(recovery.parts).map(([k, v]) => (
            <View key={k} style={styles.part}>
              <Text style={[styles.partVal, { color: c.text }]}>{v}</Text>
              <Text style={[styles.partLabel, { color: c.subtext }]}>{PART_LABEL[k] ?? k}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Sleep debt / consistency / training-load flags */}
      {composites.length > 0 && (
        <View style={[styles.flags, { borderTopColor: c.border }]}>
          {composites.map((f) => (
            <View key={f.type} style={styles.flagRow}>
              <Text style={styles.flagEmoji}>{COMPOSITE_EMOJI[f.type] ?? '•'}</Text>
              <View style={styles.flagBody}>
                <Text style={[styles.flagTitle, { color: c.text }]}>{f.title}</Text>
                {f.detail ? (
                  <Text style={[styles.flagDetail, { color: c.subtext }]}>{f.detail}</Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  ring: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  score: { fontSize: 30, fontWeight: '700', letterSpacing: -1 },
  scoreUnit: { ...typography.caption, fontSize: 11, marginTop: -2 },
  scoreMeta: { flex: 1, gap: spacing.xs },
  band: { ...typography.subtitle, fontSize: 16, fontWeight: '700' },
  detail: { ...typography.caption, fontSize: 13, lineHeight: 18 },
  parts: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    borderTopWidth: 1,
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },
  part: { alignItems: 'center' },
  partVal: { ...typography.subtitle, fontSize: 20, fontWeight: '600' },
  partLabel: { ...typography.caption, fontSize: 11, marginTop: 2 },
  flags: { borderTopWidth: 1, marginTop: spacing.md, paddingTop: spacing.sm, gap: spacing.sm },
  flagRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  flagEmoji: { fontSize: 16, marginTop: 1 },
  flagBody: { flex: 1 },
  flagTitle: { ...typography.body, fontWeight: '600', fontSize: 14 },
  flagDetail: { ...typography.caption, fontSize: 12, lineHeight: 17, marginTop: 1 },
});
