import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, colors, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import type { Recovery, HealthComposite } from '../hooks/useBriefing';

interface Props {
  recovery: Recovery | null | undefined;
  composites?: HealthComposite[];
  builtAt?: string;
}

const PART_LABEL: Record<string, string> = {
  hrv: 'HRV',
  hrvTrend: 'HRV trend',
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
function formatBuiltAt(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function RecoveryCard({ recovery, composites = [], builtAt }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!recovery || recovery.score == null) return null;

  // Only the three known bands get a status color/label; an unknown/missing band
  // is shown neutral grey rather than falling through to red "Low" (which would
  // be a false alarm on a valid score with no band).
  const bandColor =
    recovery.band === 'green' ? colors.green
      : recovery.band === 'yellow' ? colors.yellow
      : recovery.band === 'red' ? colors.red
      : c.subtext;
  const bandLabel =
    recovery.band === 'green' ? 'Recovered'
      : recovery.band === 'yellow' ? 'Moderate'
      : recovery.band === 'red' ? 'Low'
      : 'Recovery';

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="🔋" title="Recovery" />

      <View style={styles.scoreRow}>
        <View style={[styles.ring, { borderColor: bandColor }]}>
          <Text style={[styles.score, { color: c.text }]}>{Math.round(recovery.score)}</Text>
          <Text style={[styles.scoreUnit, { color: c.subtext }]}>/ 100</Text>
        </View>
        <View style={styles.scoreMeta}>
          <Text style={[styles.band, { color: bandColor }]}>
            {bandLabel}
          </Text>
          {recovery.detail ? (
            <Text style={[styles.detail, { color: c.subtext }]}>
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
              <View style={styles.partValRow}>
                <Text style={[styles.partVal, { color: c.text }]}>{Math.round(Number(v))}</Text>
                <Text style={[styles.partValUnit, { color: c.subtext }]}>/100</Text>
              </View>
              <Text style={[styles.partLabel, { color: c.subtext }]}>{PART_LABEL[k] ?? k}</Text>
            </View>
          ))}
        </View>
      )}
      {Object.keys(recovery.parts || {}).length > 0 && (
        <Text style={[styles.partsCaption, { color: c.subtext }]}>
          percentile vs your 30-day baseline{formatBuiltAt(builtAt) ? ` · as of ${formatBuiltAt(builtAt)}` : ''}
        </Text>
      )}

      {/* Raw sensor readings — the actual ms/bpm values, separate from the baseline percentiles */}
      {(recovery.rawHrv != null || recovery.rawRhr != null) && (
        <View style={[styles.rawRow, { borderTopColor: c.border }]}>
          {recovery.rawHrv != null && (
            <Text style={[styles.rawItem, { color: c.subtext }]}>
              HRV <Text style={{ color: c.text, fontWeight: '600' }}>{Math.round(recovery.rawHrv)}ms</Text>
            </Text>
          )}
          {recovery.rawRhr != null && (
            <Text style={[styles.rawItem, { color: c.subtext }]}>
              RHR <Text style={{ color: c.text, fontWeight: '600' }}>{Math.round(recovery.rawRhr)}bpm</Text>
            </Text>
          )}
        </View>
      )}
      {(recovery.rawHrv != null || recovery.rawRhr != null) && (
        <Text style={[styles.partsCaption, { color: c.subtext }]}>overnight reading · Eight Sleep</Text>
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
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
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
  partValRow: { flexDirection: 'row', alignItems: 'baseline', gap: 2 },
  partVal: { ...typography.subtitle, fontSize: 20, fontWeight: '600' },
  partValUnit: { ...typography.caption, fontSize: 11 },
  partLabel: { ...typography.caption, fontSize: 11, marginTop: 2 },
  partsCaption: { ...typography.caption, fontSize: 11, textAlign: 'center', marginTop: spacing.xs, fontStyle: 'italic' },
  rawRow: { flexDirection: 'row', gap: spacing.lg, justifyContent: 'center', borderTopWidth: 1, marginTop: spacing.sm, paddingTop: spacing.sm },
  rawItem: { fontSize: 12 },
  flags: { borderTopWidth: 1, marginTop: spacing.md, paddingTop: spacing.sm, gap: spacing.sm },
  flagRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  flagEmoji: { fontSize: 16, marginTop: 1 },
  flagBody: { flex: 1 },
  flagTitle: { ...typography.body, fontWeight: '600', fontSize: 14 },
  flagDetail: { ...typography.caption, fontSize: 12, lineHeight: 17, marginTop: 1 },
});
