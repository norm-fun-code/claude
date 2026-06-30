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
  { key: 'late_caffeine', label: 'Late caffeine',     emoji: '☕' },
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
  const fetchDateRef = useRef('');

  async function fetchToday() {
    fetchDateRef.current = localDateStr();
    try {
      const res = await fetchWithTimeout(CONTEXT_TODAY_URL, { headers: authHeaders() });
      if (!res.ok) return;
      const t = await res.json();
      if (t?.active) setActive(t.active);
    } catch { /* offline — start blank */ }
  }

  useEffect(() => { fetchToday(); }, []);

  // Reset on a new calendar day when the app returns to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && fetchDateRef.current !== localDateStr()) {
        setActive({});
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

  const count = Object.values(active).filter(Boolean).length;

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="🌙" title={savedTick ? 'Context saved' : "Last night's context"} />
      <Text style={[styles.sub, { color: c.subtext }]}>
        Tag what was different — NormOS learns how each moves your sleep & HRV.
      </Text>
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
      {count > 0 && (
        <Text style={[styles.footer, { color: c.subtext }]}>
          {count} tagged · patterns appear in your Health insights as they build up
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  sub: { ...typography.caption, fontSize: 12, marginBottom: spacing.md, marginTop: -2, lineHeight: 17 },
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
  footer: { ...typography.caption, fontSize: 11, marginTop: spacing.md, fontStyle: 'italic' },
});
