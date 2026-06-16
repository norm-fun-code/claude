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
import { WeeklyReview, LeverageAction } from '../hooks/useBriefing';

type PriorGoal = { text: string; achieved: boolean };

interface Props {
  review?: WeeklyReview | null;
  actions?: LeverageAction[];
}

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

export function WeeklyIntentionsCard({ review = null, actions = [] }: Props = {}) {
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

  // Current week's goals with live achieved state — tappable any day of the week.
  const [currentGoals, setCurrentGoals] = useState<PriorGoal[]>([]);
  const [currentWeek, setCurrentWeek] = useState<string | null>(null);

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
          setContext(typeof intention.context === 'string' ? intention.context : '');
          if (typeof intention.weekStart === 'string') setCurrentWeek(intention.weekStart);
          // Goals may come back as { text, achieved } objects or legacy strings.
          const rawGoals = Array.isArray(intention.goals) ? intention.goals : [];
          const g = rawGoals
            .map((x: unknown) => {
              if (x && typeof x === 'object') return String((x as { text?: unknown }).text ?? '');
              return String(x ?? '');
            })
            .filter(Boolean)
            .slice(0, MAX_GOALS);
          setGoals(g.length ? g : ['']);
          // Also track achieved state for mid-week checkboxes.
          setCurrentGoals(
            rawGoals
              .map((x: unknown) => {
                const o = (x ?? {}) as { text?: unknown; achieved?: unknown };
                return { text: String(o.text ?? x ?? ''), achieved: o.achieved === true };
              })
              .filter((g: PriorGoal) => g.text)
              .slice(0, MAX_GOALS)
          );
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

  // Visibility: show when it's Sunday, when there's an entry for the week, or
  // when there's an AI review to surface — unless dismissed. If nothing is set
  // and there's no review, it lingers early in the week (Mon/Tue) then hides.
  if (!loaded || dismissed) return null;
  if (!saved && !(review && review.headline) && !isSunday()) {
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

  // Toggle achievement for a CURRENT week goal — available any day, not just Sunday.
  async function toggleCurrent(i: number) {
    const toggled = currentGoals.map((g, idx) => (idx === i ? { ...g, achieved: !g.achieved } : g));
    setCurrentGoals(toggled);
    try {
      const res = await fetchWithTimeout(INTENTIONS_RESULTS_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ weekStart: currentWeek, achieved: toggled.map((g) => g.achieved) }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
    } catch {
      setCurrentGoals((prev) => prev.map((g, idx) => (idx === i ? { ...g, achieved: !g.achieved } : g)));
    }
  }

  // AI weekly review — replaces the old manual "what did you hit?" checklist.
  // The achieved state for last week's goals is already captured live (each goal
  // is tappable through its own week), so the review is the richer retrospective.
  const hasReview = !!(review && review.headline);
  const Bullets = ({ label, items, color }: { label: string; items?: string[]; color: string }) =>
    items && items.length ? (
      <View style={styles.reviewBlock}>
        <Text style={[styles.blockLabel, { color: c.subtext }]}>{label}</Text>
        {items.map((it, i) => (
          <View key={i} style={styles.bulletRow}>
            <View style={[styles.dot, { backgroundColor: color }]} />
            <Text style={[styles.bulletText, { color: c.text }]}>{it}</Text>
          </View>
        ))}
      </View>
    ) : null;

  // Condensed retrospective — headline, a short narrative, and the top couple of
  // wins/watch-outs. The full review (all bullets) lives in the weekly email.
  const reviewBlock = hasReview ? (
    <View style={styles.priorBox}>
      <Text style={[styles.label, { color: c.subtext }]}>Last week</Text>
      <Text style={[styles.reviewHeadline, { color: c.text }]}>{review!.headline}</Text>
      {review!.narrative ? (
        <Text style={[styles.reviewNarrative, { color: c.subtext }]} numberOfLines={4}>{review!.narrative}</Text>
      ) : null}
      <Bullets label="WINS" items={review!.wins?.slice(0, 2)} color={c.green} />
      <Bullets label="WATCH-OUTS" items={review!.watchouts?.slice(0, 2)} color={c.red} />
    </View>
  ) : null;

  // AI's highest-leverage actions for the week, shown under your own goals.
  const leverageBlock =
    actions.length > 0 ? (
      <View style={styles.leverageBox}>
        <Text style={[styles.label, { color: c.subtext }]}>Highest leverage this week</Text>
        {actions.map((a, i) => (
          <View key={i} style={styles.action}>
            <View style={[styles.rank, { backgroundColor: c.accent }]}>
              <Text style={styles.rankText}>{i + 1}</Text>
            </View>
            <View style={styles.actionBody}>
              <Text style={[styles.actionTitle, { color: c.text }]}>{a.title}</Text>
              {a.detail ? <Text style={[styles.actionDetail, { color: c.subtext }]}>{a.detail}</Text> : null}
            </View>
          </View>
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

  // Saved summary — the day-to-day view: last week's AI review (if any), this
  // week's goals, and the highest-leverage actions. Tap to edit.
  if (saved && !editing) {
    return (
      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
        <SectionHeader emoji="🎯" title={hasReview ? 'Weekly review + reset' : 'This week’s focus'} />
        {reviewBlock}
        {currentGoals.length > 0 ? (
          <View style={hasReview ? styles.thisWeekBox : undefined}>
            {hasReview && <Text style={[styles.label, { color: c.subtext, marginBottom: 6 }]}>This week</Text>}
            {currentGoals.map((g, i) => (
              <TouchableOpacity key={i} onPress={() => toggleCurrent(i)} style={styles.priorRow} activeOpacity={0.6}>
                <View style={[styles.checkbox, { borderColor: g.achieved ? c.accent : c.border, backgroundColor: g.achieved ? c.accent : 'transparent' }]}>
                  {g.achieved && <Text style={styles.checkmark}>✓</Text>}
                </View>
                <Text style={[styles.summaryGoal, { color: g.achieved ? c.subtext : c.text }, g.achieved && { textDecorationLine: 'line-through' }]}>{g.text}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : (
          <Text style={[styles.summaryGoal, { color: c.subtext }]}>No goals set this week.</Text>
        )}
        {context ? <Text style={[styles.summaryContext, { color: c.subtext }]} numberOfLines={4}>{context}</Text> : null}
        {leverageBlock}
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
      {reviewBlock}
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
  // AI weekly-review block (last week)
  reviewHeadline: { ...typography.subtitle, fontSize: 16, marginTop: 2, marginBottom: spacing.xs },
  reviewNarrative: { ...typography.body, fontSize: 14, marginBottom: spacing.xs, lineHeight: 20 },
  reviewBlock: { marginTop: spacing.sm },
  blockLabel: { ...typography.label, fontSize: 10, marginBottom: spacing.xs },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginBottom: spacing.xs },
  dot: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
  bulletText: { ...typography.body, fontSize: 14, flex: 1 },
  // Highest-leverage actions block
  leverageBox: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#8884' },
  action: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, alignItems: 'flex-start' },
  rank: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  rankText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  actionBody: { flex: 1 },
  actionTitle: { ...typography.subtitle, marginBottom: 2 },
  actionDetail: { ...typography.body, fontSize: 13 },
  summaryGoal: { ...typography.body, fontWeight: '500', marginBottom: 2 },
  summaryContext: { ...typography.caption, fontSize: 13, marginTop: spacing.sm, lineHeight: 19 },
  thisWeekBox: { marginTop: spacing.sm },
  editLink: { marginTop: spacing.sm },
  editLinkText: { ...typography.body, fontWeight: '600' },
});
