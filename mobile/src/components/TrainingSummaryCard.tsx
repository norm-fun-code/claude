import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { WORKOUT_COMPLETIONS_URL, authHeaders, fetchWithTimeout, localTz } from '../config';
import { describeTrainingSummary, type WorkoutCompletionFact } from '../lib/workoutSummary';
import type { EffectiveWorkoutFact } from '../lib/healthState';

interface Props {
  effectiveWorkout: EffectiveWorkoutFact | null | undefined;
  // Shared Training drill-in invalidation contract (App.tsx): bumped
  // whenever the Training drill-in closes, so this card's completion fetch
  // re-fires even when a mutation (e.g. toggling completion on the SAME
  // workoutId) didn't change effectiveWorkout?.workoutId at all.
  refreshKey?: number;
  onOpenTraining: () => void;
  onSwap: () => void;
  onLogDifferent: () => void;
}

function todayKey(): string {
  const tz = localTz();
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

/**
 * Health tab redesign (audit rec #4) — "Today's training" summary. Shows the
 * canonical effective workout (backend getEffectiveWorkout, via
 * BriefingData.effectiveWorkout — the SAME field Today's plan-conflict guard
 * reads) with its adjustment reason and completion state, WITHOUT the full
 * exercise/set list — that detail lives one tap away in the Training screen
 * (WorkoutsPanel, unchanged). Completion is read from the same
 * workout_completions endpoint WorkoutsPanel itself hydrates from, so the two
 * screens can never show a different "done" state for the same day.
 */
function TrainingSummaryCard({ effectiveWorkout, refreshKey, onOpenTraining, onSwap, onLogDifferent }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [completion, setCompletion] = useState<WorkoutCompletionFact | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const day = todayKey();
        const res = await fetchWithTimeout(`${WORKOUT_COMPLETIONS_URL}?from=${day}&to=${day}`, { headers: authHeaders() });
        if (cancelled || !res.ok) return;
        const { completions } = await res.json();
        setCompletion(completions?.[day] ?? null);
      } catch {
        // Best-effort — the card still shows the effective workout without a
        // completion badge rather than blocking on this secondary read.
      }
    })();
    return () => { cancelled = true; };
  }, [effectiveWorkout?.workoutId, refreshKey]);

  const summary = describeTrainingSummary(effectiveWorkout, completion);

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <TouchableOpacity onPress={onOpenTraining} activeOpacity={0.7}>
        <View style={styles.headRow}>
          <Text style={[styles.label, { color: c.text }]}>{summary.label}</Text>
          {summary.isDone ? (
            <View style={[styles.doneBadge, { backgroundColor: '#1D9E7522' }]}>
              <Text style={[styles.doneBadgeText, { color: '#1D9E75' }]}>Done</Text>
            </View>
          ) : null}
        </View>
        {summary.duration ? <Text style={[styles.duration, { color: c.subtext }]}>⏱ {summary.duration}</Text> : null}
        {summary.isAdjusted ? (
          <Text style={[styles.adjusted, { color: '#BA7517' }]}>{summary.adjustmentReason}</Text>
        ) : null}
      </TouchableOpacity>

      <View style={styles.actionsRow}>
        <TouchableOpacity onPress={onOpenTraining} style={[styles.primaryBtn, { backgroundColor: c.accent }]} activeOpacity={0.8}>
          <Text style={styles.primaryBtnText}>{summary.primaryActionLabel}</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.secondaryRow}>
        <TouchableOpacity onPress={onSwap} hitSlop={8}>
          <Text style={[styles.secondaryText, { color: c.subtext }]}>Swap</Text>
        </TouchableOpacity>
        {effectiveWorkout?.source && effectiveWorkout.source !== 'scheduled' ? (
          <TouchableOpacity onPress={onSwap} hitSlop={8}>
            <Text style={[styles.secondaryText, { color: c.subtext }]}>Use scheduled workout</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity onPress={onLogDifferent} hitSlop={8}>
          <Text style={[styles.secondaryText, { color: c.subtext }]}>Log a different activity</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md, gap: spacing.sm },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { ...typography.subtitle, fontSize: 18, fontWeight: '700' },
  doneBadge: { borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3 },
  doneBadgeText: { fontSize: 11, fontWeight: '700' },
  duration: { ...typography.caption, fontSize: 13 },
  adjusted: { ...typography.caption, fontSize: 13, fontWeight: '600', marginTop: 2 },
  actionsRow: { marginTop: spacing.xs },
  primaryBtn: { borderRadius: radius.md, paddingVertical: spacing.sm + 2, alignItems: 'center' },
  primaryBtnText: { color: '#FFF', fontSize: 15, fontWeight: '700' },
  secondaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.xs },
  secondaryText: { fontSize: 13, fontWeight: '600', textDecorationLine: 'underline' },
});

const TrainingSummaryCardMemo = React.memo(TrainingSummaryCard);
export { TrainingSummaryCardMemo as TrainingSummaryCard };
