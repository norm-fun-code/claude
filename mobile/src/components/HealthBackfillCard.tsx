import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { useHealthBackfill } from '../hooks/useHealthBackfill';
import { EIGHT_SLEEP_BACKFILL_URL, authHeaders } from '../config';

const DAYS = 365;

function EightSleepBackfill() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [detail, setDetail] = useState('');

  const run = async () => {
    setStatus('running');
    setDetail('');
    try {
      const res = await fetch(`${EIGHT_SLEEP_BACKFILL_URL}?days=60`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const json = await res.json();
      if (!res.ok) { setStatus('error'); setDetail(json.error ?? 'Unknown error'); return; }
      setStatus('done');
      setDetail(`${json.days} nights · ${json.metrics} data points loaded`);
    } catch (e: any) {
      setStatus('error');
      setDetail(e.message ?? 'Network error');
    }
  };

  const running = status === 'running';
  const done = status === 'done';
  const errored = status === 'error';

  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: c.text }]}>Eight Sleep History</Text>
      <Text style={[styles.sectionBody, { color: c.subtext }]}>
        Pulls 60 nights of HRV, resting HR, sleep score, and sleep hours from Eight Sleep.
        Required for the recovery score baseline — Apple Health alone won't populate this.
      </Text>
      {(running || done || errored) && (
        <View style={[styles.statusBox, { backgroundColor: c.accentSoft, borderColor: c.border }]}>
          {running && <ActivityIndicator size="small" color={c.accent} style={{ marginBottom: 4 }} />}
          <Text style={[styles.progressText, { color: done ? c.green : errored ? c.red : c.accent }]}>
            {running ? 'Contacting Eight Sleep…' : detail}
          </Text>
        </View>
      )}
      <TouchableOpacity
        style={[styles.button, { backgroundColor: running ? c.accentSoft : c.accent }]}
        onPress={run}
        disabled={running}
        activeOpacity={0.8}
      >
        <Text style={[styles.buttonText, { color: running ? c.accent : '#fff' }]}>
          {running ? 'Syncing…' : done ? 'Sync Again' : 'Sync 60 Nights'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

export function HealthBackfillCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const { status, progress, daysLoaded, rowsUploaded, error, start } = useHealthBackfill();

  const running = status === 'running';
  const done = status === 'done';

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <Text style={[styles.label, { color: c.subtext }]}>HEALTH HISTORY SYNC</Text>

      {/* Apple Health section */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: c.text }]}>Apple Health — {DAYS} Days</Text>
        <Text style={[styles.sectionBody, { color: c.subtext }]}>
          Pulls your full HRV, sleep, steps, resting heart rate, and active energy history from
          HealthKit. Safe to re-run — idempotent. Takes ~15 seconds.
        </Text>
        {(status === 'running' || status === 'done' || status === 'error') && (
          <View style={[styles.statusBox, { backgroundColor: c.accentSoft, borderColor: c.border }]}>
            {running && <ActivityIndicator size="small" color={c.accent} style={{ marginBottom: 4 }} />}
            <Text style={[styles.progressText, { color: done ? c.green : error ? c.red : c.accent }]}>
              {error ?? progress}
            </Text>
            {done && (
              <Text style={[styles.statsText, { color: c.subtext }]}>
                {daysLoaded} days · {rowsUploaded.toLocaleString()} data points
              </Text>
            )}
          </View>
        )}
        <TouchableOpacity
          style={[styles.button, { backgroundColor: running ? c.accentSoft : c.accent }]}
          onPress={() => start(DAYS)}
          disabled={running}
          activeOpacity={0.8}
        >
          <Text style={[styles.buttonText, { color: running ? c.accent : '#fff' }]}>
            {running ? 'Syncing…' : done ? 'Sync Again' : `Sync ${DAYS} Days`}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.divider, { backgroundColor: c.border }]} />

      <EightSleepBackfill />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  label: { ...typography.label, fontSize: 10, letterSpacing: 1, marginBottom: spacing.md },
  section: { gap: spacing.sm },
  sectionTitle: { fontSize: 15, fontWeight: '600' },
  sectionBody: { ...typography.body, fontSize: 14 },
  divider: { height: 1, marginVertical: spacing.md },
  statusBox: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  progressText: { ...typography.body, fontSize: 13, fontWeight: '500' },
  statsText: { ...typography.body, fontSize: 12 },
  button: {
    borderRadius: radius.md,
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonText: { fontSize: 15, fontWeight: '600' },
});
