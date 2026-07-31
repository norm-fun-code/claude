import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, useColorScheme } from 'react-native';
import { getColors, spacing, radius, shadow } from '../theme';
import type { PlanConflict } from '../hooks/useBriefing';
import type { PlanConflictResolution } from '../lib/todayActionState';

interface Props {
  conflict: PlanConflict;
  onResolve: (workoutId: string | null) => Promise<PlanConflictResolution> | PlanConflictResolution;
}

// Today Part 1's compact resolution state: rendered ONLY when the server's
// pre-render guard (brain/claimValidator.js's findPlanConflict, re-run in
// brain/todayCommandCenter.js) detects the plan disagreeing with itself —
// e.g. the headline calls today a rest day while the effective workout is
// Pull. Never guesses which side is right; resolving writes an explicit
// workout override through the existing infrastructure (POST
// /workout/override) and triggers a scoped chief-brief resync.
export function PlanConflictCard({ conflict, onResolve }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const handlePress = async (optionId: string, workoutId: string | null) => {
    if (resolvingId) return;
    setResolvingId(optionId);
    setMessage(null);
    try {
      const result = await onResolve(workoutId);
      if (result.message) setMessage(result.message);
    } catch {
      setMessage('Couldn’t update today’s plan. Nothing was changed — try again.');
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.accent }, shadow(isDark)]}>
      <Text style={[styles.label, { color: c.accent }]}>PLAN CONFLICT</Text>
      <Text style={[styles.question, { color: c.text }]}>{conflict.question}</Text>
      <View style={styles.row}>
        {conflict.options.map((opt) => (
          <Pressable
            key={opt.id}
            onPress={() => handlePress(opt.id, opt.workoutId)}
            disabled={resolvingId != null}
            style={[styles.optionBtn, { borderColor: c.accent, opacity: resolvingId && resolvingId !== opt.id ? 0.5 : 1 }]}
            accessibilityRole="button"
          >
            {resolvingId === opt.id ? (
              <ActivityIndicator size="small" color={c.accent} />
            ) : (
              <Text style={[styles.optionText, { color: c.accent }]}>{opt.label}</Text>
            )}
          </Pressable>
        ))}
      </View>
      {message ? <Text style={[styles.message, { color: c.subtext }]} accessibilityRole="alert">{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md, borderWidth: 1.5 },
  label: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 6 },
  question: { fontSize: 15, lineHeight: 21, fontWeight: '600', marginBottom: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.sm },
  optionBtn: {
    flex: 1, minHeight: 44, borderRadius: radius.md, borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm, paddingVertical: spacing.sm,
  },
  optionText: { fontSize: 14, fontWeight: '700' },
  message: { fontSize: 12, lineHeight: 17, marginTop: spacing.sm },
});
