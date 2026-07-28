import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow, colors as themeColors, FONTS } from '../theme';
import { RecoveryOrb } from './RecoveryOrb';
import type { Recovery } from '../hooks/useBriefing';
import { resolveHealthState, type EffectiveWorkoutFact } from '../lib/healthState';

interface Props {
  recovery: Recovery | null | undefined;
  effectiveWorkout: EffectiveWorkoutFact | null | undefined;
  // On My Radar's "recoveryProvisionalCandidate" deep-links here
  // (destination.entityType === 'recovery') — this card is now what that
  // link should land on, since the old standalone RecoveryCard no longer
  // renders on the Health landing page.
  highlight?: boolean;
  onHighlightLayout?: (y: number) => void;
}

const STATE_COLOR: Record<string, string> = {
  Ready: themeColors.green,
  'Solid — near green': themeColors.warmGreen,
  'Proceed with care': themeColors.yellow,
  Recover: themeColors.red,
  Provisional: themeColors.subtext,
};

/**
 * Health tab redesign (audit rec #4) — "Today's state" hero. Replaces the
 * oversized standalone Recovery card as the FIRST thing Health shows: one
 * compact, premium answer to "what state am I in, what should I train, is
 * this reliable, why" — everything below (Training summary, Worth Knowing)
 * assumes this card already answered questions 1–3.
 *
 * Pure presentation over `resolveHealthState()` (mobile/src/lib/healthState.ts)
 * — no new recovery/workout computation lives here; `recovery` and
 * `effectiveWorkout` are the same canonical facts Today reads.
 */
function HealthStateCard({ recovery, effectiveWorkout, highlight, onHighlightLayout }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const state = resolveHealthState(recovery, effectiveWorkout);
  const tint = STATE_COLOR[state.stateLabel] ?? c.subtext;

  const score = recovery?.score ?? null;
  const tier = recovery?.proxy ? null : (recovery?.presentation?.tier ?? null);
  const band = recovery?.proxy ? null
    : tier === 'solid_near_green' ? 'warmGreen'
    : tier === 'moderate' ? 'amber'
    : (recovery?.band ?? null);

  return (
    <View
      style={[styles.card, { backgroundColor: c.card }, shadow(isDark), highlight && { borderWidth: 2, borderColor: c.accent }]}
      onLayout={highlight && onHighlightLayout ? (e) => onHighlightLayout(e.nativeEvent.layout.y) : undefined}
    >
      <View style={styles.topRow}>
        <View style={{ width: 68, height: 68, alignItems: 'center', justifyContent: 'center' }}>
          <RecoveryOrb score={score ?? undefined} band={state.isProvisional ? 'neutral' : band} size={68} />
        </View>
        <View style={styles.headline}>
          <Text style={[styles.stateLabel, { color: tint }]}>{state.stateLabel}</Text>
          <Text style={[styles.decision, { color: c.text }]}>{state.decision}</Text>
          <View style={styles.sourceRow}>
            <View style={[styles.sourceDot, { backgroundColor: state.isProvisional ? c.subtext : tint }]} />
            <Text style={[styles.sourceText, { color: c.subtext }]}>
              {state.sourceLabel}{state.isProvisional ? ' · provisional' : ''}
            </Text>
          </View>
        </View>
      </View>
      <Text style={[styles.explanation, { color: c.subtext }]}>{state.explanation}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headline: { flex: 1, gap: 2 },
  stateLabel: { fontFamily: FONTS.display, fontSize: 22, fontWeight: '700', letterSpacing: -0.4 },
  decision: { ...typography.subtitle, fontSize: 15, fontWeight: '600', marginTop: 1 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  sourceDot: { width: 6, height: 6, borderRadius: 3 },
  sourceText: { ...typography.caption, fontSize: 12 },
  explanation: { ...typography.body, fontSize: 14, lineHeight: 20, marginTop: spacing.md },
});

const HealthStateCardMemo = React.memo(HealthStateCard);
export { HealthStateCardMemo as HealthStateCard };
