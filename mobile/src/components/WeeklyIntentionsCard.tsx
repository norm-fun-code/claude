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
import { INTENTIONS_URL, INTENTIONS_CURRENT_URL, INTENTIONS_RESULTS_URL, authHeaders, fetchWithTimeout } from '../config';

type PriorGoal = { text: string; achieved: boolean };

// Sunday weekly check-in: the week's life context (free text) + up to 3 focus
// goals. This is the input the intelligence layer kept referencing — it feeds
// the advisor, weekly review, and insights (rolling 30 days). Appears on Sundays
// and lingers until set or dismissed for the week; collapses into a compact
// "this week's focus" summary once saved.
const MAX_GOALS = 3;
const ET_TZ = 'America/New_York';

// Day-of-week in Eastern Time, to match the backend's notion of "the week"
// (intentions are keyed on the ET Sunday). Using device-local time would make
// the card show/hide on the wrong day when traveling or near midnight.
function easternDayOfWeek(): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: ET_TZ, weekday: 'short' }).format(new Date());
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}
function isSunday(): boolean {
  return easternDayOfWeek() === 0;
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

  // Last week's goals (to mark hit/missed each Sunday) + the week they belong to.
  const [priorGoals, setPriorGoals] = useState<PriorGoal[]>([]);
  const [priorWeek, setPriorWeek] = useState<string | null>(null);

  // Load this week's entry (if any) so we show saved state / pre-fill the editor.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTimeout(INTENTIONS_CURRENT_URL, { headers: authHeaders() });
        if (cancelled || !res.ok) return;
        const { intention, prior } = await res.json();
        if (cancelled) return;
        if (prior && Array.isArray(prior.goals) && prior.goals.length) {
          setPriorGoals(
            prior.goals
              .map((g: unknown) => {
                const o = (g ?? {}) as { text?: unknown; achieved?: unknown };
                return { text: String(o.text ?? ''), achieved: o.achieved === true };
              })
              .filter((g: PriorGoal) => g.text)
          );
          setPriorWeek(typeof prior.weekStart === 'string' ? prior.weekStart : null);
        }
        if (intention) {
          setContext(typeof intention.context === 'string' ? intention.context : '');
          // Coerce to strings and clamp to MAX_GOALS — the server array is
          // untrusted/unvalidated shape over the network.
          const g = (Array.isArray(intention.goals) ? intention.goals : [])
            .map((x: unknown) => String(x ?? ''))
            .slice(0, MAX_GOALS);
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
    const dow = easternDayOfWeek();
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

  // Toggle whether last week's goal #i was achieved, and persist immediately
  // (optimistic — revert on failure). Keyed to the prior week on the server.
  async function togglePrior(i: number) {
    const next = priorGoals.map((g, idx) => (idx === i ? { ...g, achieved: !g.achieved } : g));
    setPriorGoals(next);
    try {
      const res = await fetchWithTimeout(INTENTIONS_RESULTS_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ weekStart: priorWeek, achieved: next.map((g) => g.achieved) }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
    } catch {
      setPriorGoals(priorGoals); // revert
    }
  }

  // Last week's goals with a tappable checkmark for hit/missed. Shown on Sundays
  // above the week's setup so you close the loop before opening a new one.
  const priorReview =
    priorGoals.length > 0 && isSunday() ? (
      <View style={styles.priorBox}>
        <Text style={[styles.label, { color: c.subtext }]}>Last week — what did you hit?</Text>
        {priorGoals.map((g, i) => (
          <TouchableOpacity key={i} onPress={() => togglePrior(i)} style={styles.priorRow} activeOpacity={0.6}>
            <View
              style={[
                styles.checkbox,
                { borderColor: g.achieved ? c.accent : c.border, backgroundColor: g.achieved ? c.accent : 'transparent' },
              ]}
            >
              {g.achieved && <Text style={styles.checkmark}>✓</Text>}
            </View>
            <Text style={[styles.priorGoalText, { color: c.text }, !g.achieved && { color: c.subtext }]}>{g.text}</Text>
          </TouchableOpacity>
        ))}
      </View>
    ) : null;

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
        {priorReview}
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
      {priorReview}
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
  priorBox: { marginBottom: spacing.md, paddingBottom: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#8884' },
  priorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  checkmark: { color: '#fff', fontSize: 14, fontWeight: '800', lineHeight: 16 },
  priorGoalText: { ...typography.body, flex: 1 },
  summaryGoal: { ...typography.body, fontWeight: '500', marginBottom: 2 },
  summaryContext: { ...typography.caption, fontSize: 13, marginTop: spacing.sm, lineHeight: 19 },
  editLink: { marginTop: spacing.sm },
  editLinkText: { ...typography.body, fontWeight: '600' },
});
