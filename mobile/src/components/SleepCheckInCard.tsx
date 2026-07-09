import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme, ActivityIndicator } from 'react-native';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, radius, typography, shadow, colors } from '../theme';
import { SectionHeader } from './SectionHeader';
import { GradientButton } from './GradientButton';
import { RECOVERY_SELF_REPORT_URL, authHeaders, fetchWithTimeout } from '../config';

interface Props {
  // Shown only when the backend reports a gap (no Pod reading + no self-report yet).
  visible: boolean;
  // Called after a successful submit so the parent can refresh its recovery view.
  onSubmitted?: () => void;
}

const QUALITY_LABELS = ['Terrible', 'Poor', 'OK', 'Good', 'Great'];
const HOURS_MIN = 3;
const HOURS_MAX = 12;

// Subjective sleep check-in for nights without an Eight Sleep reading. A 1–5
// quality + hours becomes a proxy recovery score that drives the rest of the day.
function SleepCheckInCard({ visible, onSubmitted }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [quality, setQuality] = useState<number | null>(null);
  const [hours, setHours] = useState<number>(7.5);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  if (!visible || done) return null;

  const pickQuality = (q: number) => {
    Haptics.selectionAsync();
    setQuality(q);
  };
  const bump = (delta: number) => {
    Haptics.selectionAsync();
    setHours((h) => Math.min(HOURS_MAX, Math.max(HOURS_MIN, Math.round((h + delta) * 2) / 2)));
  };

  const submit = async () => {
    if (quality == null || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetchWithTimeout(RECOVERY_SELF_REPORT_URL, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ quality, hours }),
      });
      if (res.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setDone(true);
        onSubmitted?.();
      }
    } catch {
      // best-effort — leave the card up so they can retry
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="🛌" title="How did you sleep?" tint="blue" />
      <Text style={[styles.subtitle, { color: c.subtext }]}>
        No Eight Sleep reading last night — rate it so your recovery still works today.
      </Text>

      {/* Quality 1–5 */}
      <Text style={[styles.fieldLabel, { color: c.subtext }]}>SLEEP QUALITY</Text>
      <View style={styles.dotsRow}>
        {[1, 2, 3, 4, 5].map((q) => {
          const selected = quality === q;
          return (
            <TouchableOpacity key={q} onPress={() => pickQuality(q)} style={styles.dotWrap} hitSlop={6} activeOpacity={0.7}>
              <View
                style={[
                  styles.dot,
                  { borderColor: c.border, backgroundColor: selected ? c.accent : 'transparent' },
                ]}
              >
                <Text style={[styles.dotNum, { color: selected ? '#fff' : c.text }]}>{q}</Text>
              </View>
              <Text style={[styles.dotLabel, { color: selected ? c.accent : c.subtext }]}>{QUALITY_LABELS[q - 1]}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Hours stepper */}
      <Text style={[styles.fieldLabel, { color: c.subtext }]}>HOURS SLEPT</Text>
      <View style={styles.stepperRow}>
        <TouchableOpacity onPress={() => bump(-0.5)} style={[styles.stepBtn, { borderColor: c.border }]} hitSlop={8}>
          <Text style={[styles.stepSign, { color: c.text }]}>−</Text>
        </TouchableOpacity>
        <Text style={[styles.hoursVal, { color: c.text }]}>{hours.toFixed(1)}<Text style={[styles.hoursUnit, { color: c.subtext }]}>h</Text></Text>
        <TouchableOpacity onPress={() => bump(0.5)} style={[styles.stepBtn, { borderColor: c.border }]} hitSlop={8}>
          <Text style={[styles.stepSign, { color: c.text }]}>+</Text>
        </TouchableOpacity>
      </View>

      <GradientButton
        label="Log sleep"
        onPress={submit}
        disabled={quality == null}
        loading={submitting}
        style={{ marginTop: spacing.md }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  subtitle: { ...typography.caption, fontSize: 13, marginTop: 2, marginBottom: spacing.sm, lineHeight: 18 },
  fieldLabel: { ...typography.label, fontSize: 10, letterSpacing: 0.6, marginTop: spacing.sm, marginBottom: spacing.xs },
  dotsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  dotWrap: { alignItems: 'center', flex: 1, gap: 4 },
  dot: { width: 40, height: 40, borderRadius: 20, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  dotNum: { fontSize: 16, fontWeight: '700' },
  dotLabel: { fontSize: 9, fontWeight: '500' },
  stepperRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
  stepBtn: { width: 40, height: 40, borderRadius: 20, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  stepSign: { fontSize: 22, fontWeight: '600', lineHeight: 24 },
  hoursVal: { fontSize: 30, fontWeight: '700', letterSpacing: -1, minWidth: 90, textAlign: 'center' },
  hoursUnit: { fontSize: 18, fontWeight: '600' },
  submit: { marginTop: spacing.md, borderRadius: radius.md, paddingVertical: spacing.sm + 2, alignItems: 'center' },
  submitText: { fontSize: 15, fontWeight: '700' },
});

const SleepCheckInCardMemo = React.memo(SleepCheckInCard);
export { SleepCheckInCardMemo as SleepCheckInCard };
