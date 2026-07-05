import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator, useColorScheme, AppState } from 'react-native';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, radius, typography } from '../theme';
import { GRATITUDE_TODAY_URL, GRATITUDE_URL, authHeaders, fetchWithTimeout, localDateStr } from '../config';

interface Props {
  // Called after a reflection saves — the parent marks the gratitude habit done,
  // since writing what you're grateful for IS the practice.
  onSaved: () => void;
}

// Turns the gratitude checkbox into an actual practice: write one line of what
// you're grateful for. It's saved server-side (one row per day) and reflected
// back in the evening wind-down brief, so it isn't write-only. Optional — you
// can still just tick the box — but the act of naming it is the point.
export function GratitudeReflection({ onSaved }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(false);
  // Tracks which calendar day the reflection above was loaded for — NOT a
  // boolean, so a midnight rollover (app staying open/backgrounded, same
  // pattern HabitsCard guards against) forces a refetch instead of showing
  // yesterday's text under an "already saved" label forever.
  const [loadedForDate, setLoadedForDate] = useState('');

  // Prefill from today's saved reflection (if any) whenever it opens for a day
  // it hasn't loaded yet.
  useEffect(() => {
    if (!expanded || loadedForDate === localDateStr()) return;
    const today = localDateStr();
    setLoadedForDate(today);
    (async () => {
      try {
        const res = await fetchWithTimeout(GRATITUDE_TODAY_URL, { headers: authHeaders() });
        if (!res.ok) return;
        const t = await res.json();
        setText(t?.text || '');
        setSaved(!!t?.text);
      } catch { /* start blank */ }
    })();
  }, [expanded, loadedForDate]);

  // App staying alive across midnight: reset so a new day never shows (or lets
  // you re-save) yesterday's reflection.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && loadedForDate && loadedForDate !== localDateStr()) {
        setText('');
        setSaved(false);
        setError(false);
        setLoadedForDate('');
      }
    });
    return () => sub.remove();
  }, [loadedForDate]);

  async function save() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(false);
    try {
      const res = await fetchWithTimeout(GRATITUDE_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ text: trimmed }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      setSaved(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onSaved();
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  if (!expanded) {
    return (
      <Pressable onPress={() => setExpanded(true)} hitSlop={8} style={styles.link}>
        <Text style={[styles.linkText, { color: c.accent }]}>
          {saved ? '✍️ Grateful for… (edit)' : '✍️ What are you grateful for today?'}
        </Text>
      </Pressable>
    );
  }

  return (
    <View style={[styles.box, { borderColor: c.border, backgroundColor: c.background }]}>
      <TextInput
        style={[styles.input, { color: c.text, borderColor: c.border }]}
        value={text}
        onChangeText={(t) => { setText(t); setSaved(false); }}
        placeholder="One line — a person, a moment, something small that landed today…"
        placeholderTextColor={c.subtext}
        multiline
        numberOfLines={2}
        textAlignVertical="top"
        autoCorrect
        spellCheck
      />
      <View style={styles.row}>
        <Pressable
          onPress={save}
          disabled={saving || !text.trim()}
          style={[styles.btn, { backgroundColor: c.accent, opacity: saving || !text.trim() ? 0.5 : 1 }]}
        >
          {saving ? <ActivityIndicator size="small" color="#FFF" /> : (
            <Text style={styles.btnText}>{saved ? 'Saved ✓' : 'Save'}</Text>
          )}
        </Pressable>
        <Pressable onPress={() => setExpanded(false)} hitSlop={8} style={styles.collapseBtn}>
          <Text style={[styles.collapseText, { color: c.subtext }]}>Hide</Text>
        </Pressable>
      </View>
      {error && (
        <Text style={styles.errorText}>Couldn't save — check your connection and try again.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  link: { marginTop: spacing.xs, marginBottom: spacing.sm },
  linkText: { fontSize: 13, fontWeight: '600' },
  box: { borderWidth: 1, borderRadius: radius.md, padding: spacing.sm, marginTop: spacing.xs, marginBottom: spacing.sm },
  input: {
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: spacing.sm,
    fontSize: 14,
    minHeight: 54,
    marginBottom: spacing.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  btn: { flex: 1, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center' },
  btnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },
  collapseBtn: { paddingHorizontal: spacing.xs, paddingVertical: spacing.sm },
  collapseText: { fontSize: 13, fontWeight: '500' },
  errorText: { fontSize: 12, color: '#C0392B', marginTop: spacing.sm },
});
