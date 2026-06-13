import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { useHealthBackfill } from '../hooks/useHealthBackfill';

const DAYS = 365;

export function HealthBackfillCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const { status, progress, daysLoaded, rowsUploaded, error, start } = useHealthBackfill();

  const running = status === 'running';
  const done = status === 'done';

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, shadow(isDark)]}>
      <Text style={[styles.label, { color: c.subtext }]}>APPLE HEALTH HISTORY SYNC</Text>
      <Text style={[styles.title, { color: c.text }]}>
        Load {DAYS} Days of Health Data
      </Text>
      <Text style={[styles.body, { color: c.subtext }]}>
        Pulls your full HRV, sleep, steps, resting heart rate, and active energy history from
        HealthKit and loads it into NormOS. With more data, the intelligence layer can find
        stronger correlations and longer-term trends.
      </Text>
      <Text style={[styles.note, { color: c.subtext }]}>
        Safe to re-run — idempotent. Takes ~15 seconds.
      </Text>

      {(status === 'running' || status === 'done' || status === 'error') && (
        <View style={[styles.statusBox, { backgroundColor: c.accentSoft, borderColor: c.border }]}>
          {running && <ActivityIndicator size="small" color={c.accent} style={styles.spinner} />}
          <Text style={[styles.progressText, { color: done ? c.green : error ? c.red : c.accent }]}>
            {error ?? progress}
          </Text>
          {done && (
            <Text style={[styles.statsText, { color: c.subtext }]}>
              Analysis is rebuilding with your full dataset. Check the Insights tab in a few minutes.
            </Text>
          )}
        </View>
      )}

      <TouchableOpacity
        style={[
          styles.button,
          { backgroundColor: running ? c.accentSoft : c.accent },
        ]}
        onPress={() => start(DAYS)}
        disabled={running}
        activeOpacity={0.8}
      >
        <Text style={[styles.buttonText, { color: running ? c.accent : '#fff' }]}>
          {running ? 'Syncing…' : done ? 'Sync Again' : `Sync ${DAYS} Days`}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  label: { ...typography.label, fontSize: 10, letterSpacing: 1, marginBottom: spacing.xs },
  title: { ...typography.subtitle, fontSize: 17, marginBottom: spacing.sm },
  body: { ...typography.body, fontSize: 14, marginBottom: spacing.sm },
  note: { ...typography.body, fontSize: 12, marginBottom: spacing.md, fontStyle: 'italic' },
  statusBox: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.sm,
    marginBottom: spacing.md,
    flexDirection: 'column',
    gap: spacing.xs,
  },
  spinner: { alignSelf: 'flex-start', marginBottom: spacing.xs },
  progressText: { ...typography.body, fontSize: 13, fontWeight: '500' },
  statsText: { ...typography.body, fontSize: 12 },
  button: {
    borderRadius: radius.md,
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonText: { fontSize: 15, fontWeight: '600' },
});
