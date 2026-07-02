import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator, useColorScheme, AppState } from 'react-native';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, radius, typography } from '../theme';
import { EAT_HEALTHY_TODAY_URL, EAT_HEALTHY_SCORE_URL, authHeaders, fetchWithTimeout, localDateStr } from '../config';

interface Props {
  onApply: (score: number) => void;
}

// "Not sure how to rate today?" — log what you ate/drank in free text and get
// an AI-suggested 1-5 score with a rationale, which you can apply straight to
// the Eating Healthy dot picker (or ignore and pick your own). The log text +
// suggestion are saved server-side (one row per day) so reopening this shows
// what you already logged rather than starting blank.
export function EatHealthyHelper({ onApply }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState('');
  const [scoring, setScoring] = useState(false);
  const [suggestion, setSuggestion] = useState<{ score: number; rationale: string } | null>(null);
  const [error, setError] = useState(false);
  // Tracks which calendar day the log/score above was loaded for — NOT a
  // boolean, so a midnight rollover (the app staying open/backgrounded, same
  // pattern HabitsCard guards against) forces a refetch instead of silently
  // showing yesterday's text/score forever, which could get applied as today's.
  const [loadedForDate, setLoadedForDate] = useState('');

  // Prefill from today's saved log (if any) whenever the helper opens for a day
  // it hasn't loaded yet.
  useEffect(() => {
    if (!expanded || loadedForDate === localDateStr()) return;
    const today = localDateStr();
    setLoadedForDate(today);
    (async () => {
      try {
        const res = await fetchWithTimeout(EAT_HEALTHY_TODAY_URL, { headers: authHeaders() });
        if (!res.ok) return;
        const t = await res.json();
        setText(t?.text || '');
        setSuggestion(Number.isFinite(t?.score) ? { score: t.score, rationale: t.rationale || '' } : null);
      } catch { /* start blank */ }
    })();
  }, [expanded, loadedForDate]);

  // App staying alive across midnight: reset so a new day never shows (or lets
  // you apply) yesterday's meal log/score.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && loadedForDate && loadedForDate !== localDateStr()) {
        setText('');
        setSuggestion(null);
        setError(false);
        setLoadedForDate('');
      }
    });
    return () => sub.remove();
  }, [loadedForDate]);

  async function getScore() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setScoring(true);
    setError(false);
    setSuggestion(null);
    try {
      const res = await fetchWithTimeout(EAT_HEALTHY_SCORE_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ text: trimmed }),
      }, 30000);
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const { score, rationale } = await res.json();
      setSuggestion({ score, rationale });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch {
      setError(true);
    } finally {
      setScoring(false);
    }
  }

  function apply() {
    if (!suggestion) return;
    Haptics.selectionAsync();
    onApply(suggestion.score);
  }

  if (!expanded) {
    return (
      <Pressable onPress={() => setExpanded(true)} hitSlop={8} style={styles.link}>
        <Text style={[styles.linkText, { color: c.accent }]}>🍽️ Not sure? Log what you ate</Text>
      </Pressable>
    );
  }

  return (
    <View style={[styles.box, { borderColor: c.border, backgroundColor: c.background }]}>
      <Text style={[styles.hint, { color: c.subtext }]}>
        Log what you ate and drank today — meals, snacks, drinks — and get a suggested score.
      </Text>
      <TextInput
        style={[styles.input, { color: c.text, borderColor: c.border }]}
        value={text}
        onChangeText={setText}
        placeholder="e.g. oatmeal + coffee, chicken salad for lunch, wine and pasta for dinner…"
        placeholderTextColor={c.subtext}
        multiline
        numberOfLines={3}
        textAlignVertical="top"
      />
      <View style={styles.row}>
        <Pressable
          onPress={getScore}
          disabled={scoring || !text.trim()}
          style={[styles.btn, { backgroundColor: c.accent, opacity: scoring || !text.trim() ? 0.5 : 1 }]}
        >
          {scoring ? <ActivityIndicator size="small" color="#FFF" /> : (
            <Text style={styles.btnText}>Get my score</Text>
          )}
        </Pressable>
        <Pressable onPress={() => setExpanded(false)} hitSlop={8} style={styles.collapseBtn}>
          <Text style={[styles.collapseText, { color: c.subtext }]}>Hide</Text>
        </Pressable>
      </View>
      {error && (
        <Text style={styles.errorText}>Couldn't get a score — check your connection and try again.</Text>
      )}
      {suggestion && (
        <View style={[styles.suggestionBox, { borderColor: c.accent, backgroundColor: c.accentSoft }]}>
          <Text style={[styles.suggestionScore, { color: c.accent }]}>AI suggests: {suggestion.score}/5</Text>
          {!!suggestion.rationale && (
            <Text style={[styles.suggestionRationale, { color: c.text }]}>{suggestion.rationale}</Text>
          )}
          <Pressable onPress={apply} style={[styles.applyBtn, { backgroundColor: c.accent }]}>
            <Text style={styles.applyBtnText}>Apply {suggestion.score}/5</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  link: { marginTop: spacing.sm },
  linkText: { fontSize: 13, fontWeight: '600' },
  box: { borderWidth: 1, borderRadius: radius.md, padding: spacing.sm, marginTop: spacing.sm },
  hint: { ...typography.caption, fontSize: 12, marginBottom: spacing.sm, lineHeight: 17 },
  input: {
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: spacing.sm,
    fontSize: 14,
    minHeight: 70,
    marginBottom: spacing.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  btn: { flex: 1, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center' },
  btnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },
  collapseBtn: { paddingHorizontal: spacing.xs, paddingVertical: spacing.sm },
  collapseText: { fontSize: 13, fontWeight: '500' },
  errorText: { fontSize: 12, color: '#C0392B', marginTop: spacing.sm },
  suggestionBox: { borderWidth: 1, borderRadius: radius.md, padding: spacing.sm, marginTop: spacing.sm },
  suggestionScore: { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  suggestionRationale: { fontSize: 13, lineHeight: 18, marginBottom: spacing.sm },
  applyBtn: { borderRadius: radius.sm, paddingVertical: spacing.xs + 2, alignItems: 'center' },
  applyBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 },
});
