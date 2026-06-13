import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  useColorScheme,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { SLEEP_LOG_URL, SLEEP_TODAY_URL, CONSOLIDATE_URL, authHeaders, fetchWithTimeout } from '../config';

const CACHE_KEY = 'normos.sleep.today.v1';

interface TodayMetrics {
  hrv?: number;
  resting_hr?: number;
  sleep_score?: number;
  sleep_hours?: number;
}

function todayKey(): string {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
}

function fmt(v: number | undefined, unit: string) {
  return v != null ? `${v}${unit}` : '—';
}

export function SleepLogCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const [today, setToday] = useState<TodayMetrics | null>(null);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'ok' | 'error'>('idle');

  const [hrv, setHrv] = useState('');
  const [rhr, setRhr] = useState('');
  const [score, setScore] = useState('');
  const [hours, setHours] = useState('');

  // Load: AsyncStorage first (instant), then confirm with server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cached = await AsyncStorage.getItem(CACHE_KEY);
        if (cached) {
          const { date, metrics } = JSON.parse(cached);
          if (date === todayKey() && !cancelled) {
            setToday(metrics);
            setLoading(false);
            return; // cache hit — skip server call
          }
        }
      } catch { /* ignore */ }

      // No cache or stale — ask server
      try {
        const res = await fetchWithTimeout(SLEEP_TODAY_URL, { headers: authHeaders() }, 10000);
        if (res.ok && !cancelled) {
          const json = await res.json();
          if (json.logged) {
            setToday(json.metrics);
            // Write to cache so next load is instant
            await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ date: todayKey(), metrics: json.metrics })).catch(() => {});
          } else {
            setToday(null);
            setEditing(true);
          }
        }
      } catch { /* best-effort — show form */ } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const save = useCallback(async () => {
    if (saving) return;
    const body: Record<string, number> = {};
    if (hrv)   body.hrv          = Number(hrv);
    if (rhr)   body.resting_hr   = Number(rhr);
    if (score) body.sleep_score  = Number(score);
    if (hours) body.sleep_hours  = Number(hours);
    if (!Object.keys(body).length) return;

    setSaving(true);
    setSaveStatus('idle');
    try {
      const res = await fetchWithTimeout(SLEEP_LOG_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      }, 15000);
      if (res.ok) {
        const metrics = body as TodayMetrics;
        // Persist immediately to AsyncStorage so tab switches don't lose it
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ date: todayKey(), metrics })).catch(() => {});
        setToday(metrics);
        setEditing(false);
        setHrv(''); setRhr(''); setScore(''); setHours('');
        setSaveStatus('ok');
        // Background: re-consolidate self-model so morning brief reflects today's data
        fetchWithTimeout(CONSOLIDATE_URL, { method: 'POST', headers: authHeaders() }, 30000).catch(() => {});
      } else {
        setSaveStatus('error');
      }
    } catch {
      setSaveStatus('error');
    } finally {
      setSaving(false);
    }
  }, [hrv, rhr, score, hours, saving]);

  if (loading) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, shadow(isDark)]}>
      <View style={styles.headerRow}>
        <SectionHeader emoji="🛏" title="Eight Sleep" preserveCase />
        {today && !editing && (
          <TouchableOpacity onPress={() => { setEditing(true); setSaveStatus('idle'); }} hitSlop={8}>
            <Text style={[styles.editBtn, { color: c.subtext }]}>Edit</Text>
          </TouchableOpacity>
        )}
      </View>

      {today && !editing ? (
        <View>
          <View style={styles.metricsRow}>
            <Metric label="HRV" value={fmt(today.hrv, 'ms')} c={c} good={(today.hrv ?? 0) >= 40} dim={today.hrv == null} />
            <Metric label="RHR" value={fmt(today.resting_hr, 'bpm')} c={c} good={(today.resting_hr ?? 999) <= 60} dim={today.resting_hr == null} />
            <Metric label="SCORE" value={fmt(today.sleep_score, '')} c={c} good={(today.sleep_score ?? 0) >= 75} dim={today.sleep_score == null} />
            <Metric label="HOURS" value={fmt(today.sleep_hours, 'h')} c={c} good={(today.sleep_hours ?? 0) >= 7} dim={today.sleep_hours == null} />
          </View>
          {saveStatus === 'ok' && (
            <Text style={[styles.savedNote, { color: c.subtext }]}>
              Saved ✓ — self-model updated. Rebuild your briefing to refresh morning focus.
            </Text>
          )}
        </View>
      ) : (
        <>
          <Text style={[styles.hint, { color: c.subtext }]}>
            Open Eight Sleep app → Today → enter overnight metrics
          </Text>
          <View style={styles.inputs}>
            <Field label="HRV (ms)" value={hrv} onChange={setHrv} placeholder={today?.hrv ? String(today.hrv) : 'e.g. 42'} c={c} />
            <Field label="RHR (bpm)" value={rhr} onChange={setRhr} placeholder={today?.resting_hr ? String(today.resting_hr) : 'e.g. 52'} c={c} />
            <Field label="Sleep score" value={score} onChange={setScore} placeholder={today?.sleep_score ? String(today.sleep_score) : 'e.g. 82'} c={c} />
            <Field label="Sleep hours" value={hours} onChange={setHours} placeholder={today?.sleep_hours ? String(today.sleep_hours) : 'e.g. 7.5'} c={c} />
          </View>
          {saveStatus === 'error' && (
            <Text style={[styles.errorNote, { color: c.red }]}>Couldn't save — check your connection and try again.</Text>
          )}
          <View style={styles.buttons}>
            {today && (
              <TouchableOpacity onPress={() => { setEditing(false); setSaveStatus('idle'); }} style={[styles.cancelBtn, { borderColor: c.border }]}>
                <Text style={[styles.cancelTxt, { color: c.subtext }]}>Cancel</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={save}
              disabled={saving}
              style={[styles.saveBtn, { backgroundColor: c.accent }, !today && styles.saveBtnFull]}
            >
              {saving
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={styles.saveTxt}>Save</Text>
              }
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

function Metric({ label, value, c, good, dim }: {
  label: string; value: string; c: ReturnType<typeof getColors>; good: boolean; dim: boolean;
}) {
  return (
    <View style={styles.metric}>
      <Text style={[styles.metricLabel, { color: c.subtext }]}>{label}</Text>
      <Text style={[styles.metricValue, { color: dim ? c.subtext : good ? c.green : c.text }]}>{value}</Text>
    </View>
  );
}

function Field({ label, value, onChange, placeholder, c }: {
  label: string; value: string; onChange: (v: string) => void; placeholder: string;
  c: ReturnType<typeof getColors>;
}) {
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: c.subtext }]}>{label}</Text>
      <TextInput
        style={[styles.fieldInput, { borderColor: c.border, color: c.text }]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.subtext}
        keyboardType="decimal-pad"
        returnKeyType="next"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  editBtn: { fontSize: 13, fontWeight: '600' },
  metricsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: spacing.xs,
  },
  metric: { flex: 1, alignItems: 'center' },
  metricLabel: { ...typography.label, fontSize: 9, marginBottom: 2 },
  metricValue: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  savedNote: { fontSize: 12, lineHeight: 17, marginTop: spacing.sm, fontStyle: 'italic' },
  errorNote: { fontSize: 12, marginTop: spacing.xs },
  hint: { fontSize: 12, lineHeight: 17, marginBottom: spacing.sm },
  inputs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  field: { width: '47%' },
  fieldLabel: { ...typography.label, fontSize: 9, marginBottom: 4 },
  fieldInput: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    fontSize: 16,
    fontWeight: '600',
  },
  buttons: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  cancelBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  cancelTxt: { fontSize: 14, fontWeight: '600' },
  saveBtn: {
    flex: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  saveBtnFull: { flex: 0, width: '100%' },
  saveTxt: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
