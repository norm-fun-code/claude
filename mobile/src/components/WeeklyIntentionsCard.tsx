import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  TouchableOpacity,
  useColorScheme,
} from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';
import { INTENTIONS_URL, INTENTIONS_CURRENT_URL, authHeaders, fetchWithTimeout } from '../config';

// Sunday weekly check-in: the week's life context (free text) + up to 3 focus
// goals. This is the input the intelligence layer kept referencing — it feeds
// the advisor, weekly review, and insights (rolling 30 days). Appears on Sundays
// and lingers until set or dismissed for the week; collapses into a compact
// "this week's focus" summary once saved.
const MAX_GOALS = 3;

function isSunday(): boolean {
  return new Date().getDay() === 0;
}

export function WeeklyIntentionsCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const [context, setContext] = useState('');
  const [goals, setGoals] = useState<string[]>(['']);
  const [saved, setSaved] = useState(false);   // a saved entry exists for this week
  const [editing, setEditing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Load this week's entry (if any) so we show saved state / pre-fill the editor.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTimeout(INTENTIONS_CURRENT_URL, { headers: authHeaders() });
        if (cancelled || !res.ok) return;
        const { intention } = await res.json();
        if (cancelled) return;
        if (intention) {
          setContext(intention.context ?? '');
          const g = Array.isArray(intention.goals) ? intention.goals : [];
          setGoals(g.length ? g : ['']);
          setSaved(true);
        }
      } catch {
        /* offline — show the blank prompt */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Visibility: show when it's Sunday OR there's no entry for the week yet (so it
  // lingers into the week until you set it), unless dismissed. Once saved, it
  // only shows on Sundays as a compact summary you can tap to edit.
  if (!loaded || dismissed) return null;
  if (saved && !isSunday() && !editing) return null;
  if (!saved && !isSunday()) {
    // Past Sunday with nothing set — still let it linger early in the week (Mon/Tue).
    const dow = new Date().getDay();
    if (dow > 2) return null;
  }

  function setGoal(i: number, val: string) {
    setGoals((prev) => prev.map((g, idx) => (idx === i ? val : g)));
  }
  function addGoal() {
    setGoals((prev) => (prev.length >= MAX_GOALS ? prev : [...prev, '']));
  }
  function removeGoal(i: number) {
    setGoals((prev) => (prev.length <= 1 ? [''] : prev.filter((_, idx) => idx !== i)));
  }

  async function save() {
    setSaving(true);
    setFailed(false);
    try {
      const cleanGoals = goals.map((g) => g.trim()).filter(Boolean);
      const res = await fetchWithTimeout(INTENTIONS_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ context: context.trim(), goals: cleanGoals }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      setSaved(true);
      setEditing(false);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  const cleanGoals = goals.map((g) => g.trim()).filter(Boolean);

  // Compact saved summary (shown on later Sundays, tap to edit).
  if (saved && !editing) {
    return (
      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
        <SectionHeader emoji="🎯" title="This week’s focus" />
        {cleanGoals.length > 0 ? (
          cleanGoals.map((g, i) => (
            <Text key={i} style={[styles.summaryGoal, { color: c.text }]}>• {g}</Text>
          ))
        ) : (
          <Text style={[styles.summaryGoal, { color: c.subtext }]}>No goals set this week.</Text>
        )}
        {context ? <Text style={[styles.summaryContext, { color: c.subtext }]} numberOfLines={3}>{context}</Text> : null}
        <TouchableOpacity onPress={() => setEditing(true)} style={styles.editLink}>
          <Text style={[styles.editLinkText, { color: c.accent }]}>Edit</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Editor.
  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="🎯" title="Set your week" />
      <Text style={[styles.hint, { color: c.subtext }]}>
        Sunday reset — your focus and what’s going on this week. NormOS uses this to ground its advice and weekly review.
      </Text>

      <Text style={[styles.label, { color: c.subtext }]}>Focus goals (up to {MAX_GOALS})</Text>
      {goals.map((g, i) => (
        <View key={i} style={styles.goalRow}>
          <TextInput
            style={[styles.goalInput, { color: c.text, borderColor: c.border }]}
            placeholder={`Goal ${i + 1}`}
            placeholderTextColor={c.subtext}
            value={g}
            onChangeText={(v) => setGoal(i, v)}
            returnKeyType="done"
          />
          {goals.length > 1 && (
            <TouchableOpacity onPress={() => removeGoal(i)} style={styles.removeBtn}>
              <Text style={[styles.removeText, { color: c.subtext }]}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}
      {goals.length < MAX_GOALS && (
        <TouchableOpacity onPress={addGoal}>
          <Text style={[styles.addGoal, { color: c.accent }]}>+ Add goal</Text>
        </TouchableOpacity>
      )}

      <Text style={[styles.label, { color: c.subtext, marginTop: spacing.md }]}>What’s going on this week?</Text>
      <TextInput
        style={[styles.contextInput, { color: c.text, borderColor: c.border }]}
        placeholder="Travel, big deadline, feeling run down, family in town…"
        placeholderTextColor={c.subtext}
        value={context}
        onChangeText={setContext}
        multiline
      />

      {failed && <Text style={styles.failed}>Couldn’t save — check your connection and try again.</Text>}

      <View style={styles.actions}>
        <Pressable onPress={() => setDismissed(true)} hitSlop={8}>
          <Text style={[styles.dismiss, { color: c.subtext }]}>Not now</Text>
        </Pressable>
        <Pressable
          onPress={save}
          disabled={saving || (!cleanGoals.length && !context.trim())}
          style={[styles.saveBtn, { backgroundColor: c.accent, opacity: saving || (!cleanGoals.length && !context.trim()) ? 0.4 : 1 }]}
        >
          <Text style={styles.saveText}>{saving ? 'Saving…' : 'Set the week'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  hint: { ...typography.caption, fontSize: 13, marginBottom: spacing.md, lineHeight: 19 },
  label: { ...typography.caption, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: spacing.xs },
  goalRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  goalInput: { flex: 1, ...typography.body, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  removeBtn: { padding: spacing.xs },
  removeText: { fontSize: 15 },
  addGoal: { ...typography.body, fontWeight: '600', marginTop: spacing.xs },
  contextInput: {
    ...typography.body,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 72,
    textAlignVertical: 'top',
  },
  failed: { ...typography.caption, color: '#C0392B', marginTop: spacing.sm },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.md },
  dismiss: { ...typography.body, fontWeight: '500' },
  saveBtn: { borderRadius: radius.md, paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.lg },
  saveText: { ...typography.body, fontWeight: '700', color: '#fff' },
  summaryGoal: { ...typography.body, fontWeight: '500', marginBottom: 2 },
  summaryContext: { ...typography.caption, fontSize: 13, marginTop: spacing.sm, lineHeight: 19 },
  editLink: { marginTop: spacing.sm },
  editLinkText: { ...typography.body, fontWeight: '600' },
});
