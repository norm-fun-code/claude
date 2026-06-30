import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, useColorScheme, AppState } from 'react-native';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { CONTEXT_URL, CONTEXT_TODAY_URL, authHeaders, fetchWithTimeout, localDateStr } from '../config';

// Mirrors backend src/intelligence/context-tags.js (single source of truth there;
// kept in sync here for instant render).
const TAGS: { key: string; label: string; emoji: string }[] = [
  { key: 'magnesium',     label: 'Magnesium',         emoji: '💊' },
  { key: 'alcohol',       label: 'Alcohol',           emoji: '🍷' },
  { key: 'late_meal',     label: 'Late meal',         emoji: '🍽️' },
  { key: 'melatonin',     label: 'Melatonin',         emoji: '😴' },
  { key: 'late_workout',  label: 'Late workout',      emoji: '🏋️' },
  { key: 'stressful_day', label: 'Stressful day',     emoji: '😣' },
  { key: 'sauna',         label: 'Sauna / heat',      emoji: '🧖' },
  { key: 'cold_plunge',   label: 'Cold plunge',       emoji: '🧊' },
  { key: 'travel',        label: 'Travel',            emoji: '✈️' },
  { key: 'late_screens',  label: 'Late screens',      emoji: '📱' },
  { key: 'under_weather', label: 'Under the weather', emoji: '🤒' },
  { key: 'warm_room',     label: 'Warm room',         emoji: '🌡️' },
];

// Tag last night's context. Each tap auto-saves the full set; NormOS correlates
// these against your HRV / sleep (and mood/focus) and surfaces "X nights → Y"
// patterns in the insights once a few weeks of tags accumulate.
export function NightContextCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [savedTick, setSavedTick] = useState(false);
  const [dismissed, setDismissed] = useState(false); // hidden for the day after Submit
  const fetchDateRef = useRef('');

  async function fetchToday() {
    fetchDateRef.current = localDateStr();
    try {
      const res = await fetchWithTimeout(CONTEXT_TODAY_URL, { headers: authHeaders() });
      if (!res.ok) return;
      const t = await res.json();
      if (t?.active) setActive(t.active);
      if (t?.submitted) setDismissed(true); // already submitted today → stay hidden
    } catch { /* offline — start blank */ }
  }

  useEffect(() => { fetchToday(); }, []);

  // Reset on a new calendar day when the app returns to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && fetchDateRef.current !== localDateStr()) {
        setActive({});
        setDismissed(false);
        fetchToday();
      }
    });
    return () => sub.remove();
  }, []);

  async function save(next: Record<string, boolean>) {
    try {
      const res = await fetchWithTimeout(CONTEXT_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ active: next }),
      });
      if (res.ok) { setSavedTick(true); setTimeout(() => setSavedTick(false), 1500); }
    } catch { /* offline — next toggle resends the full set */ }
  }

  function toggle(key: string) {
    Haptics.selectionAsync();
    const next = { ...active, [key]: !active[key] };
    if (!next[key]) delete next[key];
    setActive(next);
    save(next);
  }

  // TM is a 3-state practice mapped onto two binary tags: none / morning (tm_am) /
  // twice-daily (tm_am + tm_pm). The engine then separates "any TM" from the
  // second session when correlating against daytime & overnight HRV/RHR.
  const tmLevel = active.tm_pm ? 2 : active.tm_am ? 1 : 0;
  function setTM(level: number) {
    Haptics.selectionAsync();
    const next = { ...active };
    delete next.tm_am; delete next.tm_pm;
    if (level >= 1) next.tm_am = true;
    if (level >= 2) next.tm_pm = true;
    setActive(next);
    save(next);
  }

  async function submit() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setDismissed(true); // hide immediately; persist the submit marker in the background
    try {
      await fetchWithTimeout(CONTEXT_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ active, submitted: true }),
      });
    } catch { /* already hidden locally; resends next session if needed */ }
  }

  const count = Object.values(active).filter(Boolean).length;

  if (dismissed) return null; // submitted today — card is hidden until tomorrow

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="🌙" title={savedTick ? 'Context saved' : "Last night's context"} />
      <Text style={[styles.sub, { color: c.subtext }]}>
        Tag what was different — NormOS learns how each moves your sleep & HRV.
      </Text>

      <Text style={[styles.tmLabel, { color: c.subtext }]}>🧘 Meditation (TM)</Text>
      <View style={styles.segment}>
        {[{ l: 0, t: 'None' }, { l: 1, t: 'Morning' }, { l: 2, t: 'Twice-daily' }].map((seg) => {
          const on = tmLevel === seg.l;
          return (
            <Pressable
              key={seg.l}
              onPress={() => setTM(seg.l)}
              style={[
                styles.segBtn,
                { borderColor: c.border, backgroundColor: c.background },
                on && { backgroundColor: c.accentSoft, borderColor: c.accent },
              ]}
            >
              <Text style={[styles.segTxt, { color: on ? c.accent : c.text }, on && styles.segTxtOn]}>{seg.t}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.chips}>
        {TAGS.map((t) => {
          const on = !!active[t.key];
          return (
            <Pressable
              key={t.key}
              onPress={() => toggle(t.key)}
              style={[
                styles.chip,
                { borderColor: c.border, backgroundColor: c.background },
                on && { backgroundColor: c.accentSoft, borderColor: c.accent },
              ]}
            >
              <Text style={styles.chipEmoji}>{t.emoji}</Text>
              <Text style={[styles.chipLabel, { color: on ? c.accent : c.text }, on && styles.chipLabelOn]}>
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Pressable onPress={submit} style={[styles.submit, { backgroundColor: c.accent }]}>
        <Text style={styles.submitText}>{count > 0 ? `Submit · ${count} tagged` : 'Nothing to note — done'}</Text>
      </Pressable>
      {count > 0 && (
        <Text style={[styles.footer, { color: c.subtext }]}>
          Patterns appear in your Health insights as they build up
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  sub: { ...typography.caption, fontSize: 12, marginBottom: spacing.md, marginTop: -2, lineHeight: 17 },
  tmLabel: { fontSize: 12, fontWeight: '600', marginBottom: spacing.xs },
  segment: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.md },
  segBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segTxt: { fontSize: 12, fontWeight: '500' },
  segTxtOn: { fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  chipEmoji: { fontSize: 14 },
  chipLabel: { fontSize: 13, fontWeight: '500' },
  chipLabelOn: { fontWeight: '700' },
  submit: {
    marginTop: spacing.md,
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  submitText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  footer: { ...typography.caption, fontSize: 11, marginTop: spacing.sm, fontStyle: 'italic', textAlign: 'center' },
});
