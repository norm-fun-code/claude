import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow, colors as themeColors, FONTS } from '../theme';
import type { WealthLanding } from '../hooks/useBriefing';

interface Props {
  landing: WealthLanding | null | undefined;
}

const POSTURE_LABEL: Record<string, string> = {
  on_track: 'On track',
  ahead_of_plan: 'Ahead of plan',
  worth_watching: 'Worth watching',
  action_needed: 'Action needed',
  data_incomplete: 'Data incomplete',
};
const POSTURE_COLOR: Record<string, string> = {
  on_track: themeColors.green,
  ahead_of_plan: themeColors.purple,
  worth_watching: themeColors.yellow,
  action_needed: themeColors.red,
  data_incomplete: '#8E8E93',
};

function money(n: number | null | undefined): string {
  if (n == null) return '—';
  return (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');
}

/**
 * Wealth redesign (audit rec #5) — the ONE dominant, premium "financial
 * posture" card that leads the Wealth landing page. State is deterministic
 * and server-computed (backend/src/services/wealth-landing.js's
 * derivePosture) — never LLM-generated decoration, never re-derived here.
 * Shows only the smallest useful set of supporting numbers, each with an
 * explicit period label so MTD/rolling-30d/plan-pace/net-worth are never
 * placed beside each other without saying which is which.
 */
function WealthPostureCard({ landing }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [hidden, setHidden] = React.useState(false);

  if (!landing) {
    return (
      <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
        <Text style={[styles.postureLabel, { color: c.subtext }]}>Loading…</Text>
      </View>
    );
  }

  const tint = POSTURE_COLOR[landing.posture] ?? c.subtext;
  const label = POSTURE_LABEL[landing.posture] ?? 'Unknown';
  const { numbers, sourceHealth } = landing;
  const mask = (s: string) => (hidden ? '••••' : s);

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <View style={styles.headRow}>
        <View style={[styles.dot, { backgroundColor: tint }]} />
        <Text style={[styles.postureLabel, { color: tint }]}>{label}</Text>
      </View>

      {sourceHealth.qualification ? (
        <Text style={[styles.qualification, { color: c.subtext }]}>{sourceHealth.qualification}</Text>
      ) : null}

      <View style={styles.numbersWrap} onTouchEnd={() => setHidden((h) => !h)}>
        {numbers.mtdDiscretionary ? (
          <View style={styles.numberRow}>
            <Text style={[styles.numberLabel, { color: c.subtext }]}>Discretionary spend (MTD)</Text>
            <Text style={[styles.numberValue, { color: c.text }]}>{mask(money(numbers.mtdDiscretionary.amount))}</Text>
          </View>
        ) : null}
        {numbers.savingsRate ? (
          <View style={styles.numberRow}>
            <Text style={[styles.numberLabel, { color: c.subtext }]}>Savings rate (30d)</Text>
            <Text style={[styles.numberValue, { color: numbers.savingsRate.healthy ? themeColors.green : themeColors.red }]}>
              {mask(`${numbers.savingsRate.ratePct}%`)}
            </Text>
          </View>
        ) : null}
        {numbers.planPace ? (
          <View style={styles.numberRow}>
            <Text style={[styles.numberLabel, { color: c.subtext }]}>Pace vs. plan ({numbers.planPace.pctYearElapsed}% through year)</Text>
            <Text style={[styles.numberValue, { color: numbers.planPace.ahead ? themeColors.green : c.text }]}>
              {mask(`${numbers.planPace.ahead ? '+' : ''}${money(numbers.planPace.delta)}`)}
            </Text>
          </View>
        ) : null}
        {numbers.netWorth && numbers.netWorth.trend?.material ? (
          <View style={styles.numberRow}>
            <Text style={[styles.numberLabel, { color: c.subtext }]}>Net worth ({numbers.netWorth.trend.direction} trend)</Text>
            <Text style={[styles.numberValue, { color: c.text }]}>{mask(money(numbers.netWorth.amount))}</Text>
          </View>
        ) : null}
        {numbers.cashBuffer && numbers.cashBuffer.thin ? (
          <View style={styles.numberRow}>
            <Text style={[styles.numberLabel, { color: c.subtext }]}>Cash buffer</Text>
            <Text style={[styles.numberValue, { color: themeColors.yellow }]}>{mask(money(numbers.cashBuffer.amount))}</Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.hint, { color: c.subtext }]}>{hidden ? 'tap to show' : 'tap to hide'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  postureLabel: { fontFamily: FONTS.display, fontSize: 24, fontWeight: '700', letterSpacing: -0.4 },
  qualification: { ...typography.caption, fontSize: 13, marginTop: spacing.xs, fontStyle: 'italic' },
  numbersWrap: { marginTop: spacing.md, gap: spacing.sm },
  numberRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  numberLabel: { ...typography.caption, fontSize: 13, flex: 1, marginRight: spacing.sm },
  numberValue: { ...typography.subtitle, fontSize: 17, fontWeight: '700' },
  hint: { ...typography.caption, fontSize: 11, marginTop: spacing.sm, textAlign: 'right' },
});

const WealthPostureCardMemo = React.memo(WealthPostureCard);
export { WealthPostureCardMemo as WealthPostureCard };
