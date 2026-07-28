import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow, colors as themeColors, FONTS } from '../theme';
import type { WealthLanding } from '../hooks/useBriefing';
import { paceLine, driverLine } from '../lib/wealthPaceCopy';

interface Props {
  landing: WealthLanding | null | undefined;
}

// Severity contract (backend/src/services/wealth-landing.js) — red is
// reserved for `critical` (a real, configured danger) only. `action` gets a
// distinct amber-orange so it never reads as the same alarm level as a
// genuine risk; `review` gets a softer amber for "unusual, unconfirmed" —
// never red, since it hasn't been confirmed as a real issue.
const SEVERITY_COLOR: Record<string, string> = {
  critical: themeColors.red,
  action: '#FF9F0A',
  review: '#E8B84B',
  explained: themeColors.green,
  on_track: themeColors.green,
  unavailable: '#8E8E93',
};

function money(n: number | null | undefined): string {
  if (n == null) return '—';
  return (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');
}

/**
 * Wealth redesign (audit rec #5; severity/reliability cleanup) — the ONE
 * dominant, premium "financial posture" card that leads the Wealth landing
 * page. Severity and the summary line are deterministic and server-computed
 * (backend/src/services/wealth-landing.js's deriveSeverity/summaryLabel) —
 * never LLM-generated decoration, never re-derived here. Shows only the
 * smallest useful set of supporting numbers, each with an explicit period
 * label so MTD/rolling-30d/plan-pace/net-worth are never placed beside each
 * other without saying which is which.
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

  const tint = SEVERITY_COLOR[landing.severity] ?? c.subtext;
  const { numbers, sourceHealth } = landing;
  const mask = (s: string) => (hidden ? '••••' : s);
  // Secondary body text bumped for dark-mode legibility (audit item 6) —
  // scoped to this card rather than the shared theme.subtext, which other
  // surfaces already rely on at its current weight.
  const secondary = isDark ? '#AEAEB2' : c.subtext;

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <View style={styles.headRow}>
        <View style={[styles.dot, { backgroundColor: tint }]} />
        <Text style={[styles.postureLabel, { color: tint }]} accessibilityRole="header">{landing.summary}</Text>
      </View>

      {sourceHealth.qualification ? (
        <Text style={[styles.qualification, { color: secondary }]}>{sourceHealth.qualification}</Text>
      ) : null}

      <View style={styles.numbersWrap} onTouchEnd={() => setHidden((h) => !h)} accessibilityRole="button" accessibilityLabel={hidden ? 'Show amounts' : 'Hide amounts'} accessibilityHint="Double tap to toggle privacy mask">
        {numbers.mtdDiscretionary ? (
          <View style={styles.paceBlock}>
            <View style={styles.numberRow}>
              <Text style={[styles.numberLabel, { color: secondary }]}>Discretionary spend (MTD)</Text>
              <Text style={[styles.numberValue, { color: c.text }]} allowFontScaling>{mask(money(numbers.mtdDiscretionary.amount))}</Text>
            </View>
            {numbers.mtdDiscretionary.comparison ? (
              <>
                <Text style={[styles.paceLine, { color: secondary }]} allowFontScaling>
                  {mask(paceLine(numbers.mtdDiscretionary.comparison))}
                </Text>
                {driverLine(numbers.mtdDiscretionary.comparison.drivers) ? (
                  <Text style={[styles.paceLine, { color: secondary }]} allowFontScaling>
                    {mask(driverLine(numbers.mtdDiscretionary.comparison.drivers)!)}
                  </Text>
                ) : null}
              </>
            ) : null}
          </View>
        ) : null}
        {numbers.savingsRate ? (
          <View style={styles.numberRow}>
            <Text style={[styles.numberLabel, { color: secondary }]}>Savings rate (30d)</Text>
            <Text style={[styles.numberValue, { color: numbers.savingsRate.healthy ? themeColors.green : themeColors.red }]} allowFontScaling>
              {mask(`${numbers.savingsRate.ratePct}%`)}
            </Text>
          </View>
        ) : null}
        {numbers.planPace ? (
          <View style={styles.numberRow}>
            <Text style={[styles.numberLabel, { color: secondary }]}>Pace vs. plan ({numbers.planPace.pctYearElapsed}% through year)</Text>
            <Text style={[styles.numberValue, { color: numbers.planPace.ahead ? themeColors.green : c.text }]} allowFontScaling>
              {mask(`${numbers.planPace.ahead ? '+' : ''}${money(numbers.planPace.delta)}`)}
            </Text>
          </View>
        ) : null}
        {numbers.netWorth && numbers.netWorth.trend?.material ? (
          <View style={styles.numberRow}>
            <Text style={[styles.numberLabel, { color: secondary }]}>Net worth ({numbers.netWorth.trend.direction} trend)</Text>
            <Text style={[styles.numberValue, { color: c.text }]} allowFontScaling>{mask(money(numbers.netWorth.amount))}</Text>
          </View>
        ) : null}
        {numbers.cashBuffer && (numbers.cashBuffer.thin || numbers.cashBuffer.critical) ? (
          <View style={styles.numberRow}>
            <Text style={[styles.numberLabel, { color: secondary }]}>Cash buffer</Text>
            <Text style={[styles.numberValue, { color: numbers.cashBuffer.critical ? themeColors.red : themeColors.yellow }]} allowFontScaling>
              {mask(money(numbers.cashBuffer.amount))}
            </Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.hint, { color: secondary }]}>{hidden ? 'tap to show' : 'tap to hide'}</Text>
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
  paceBlock: { gap: 2 },
  paceLine: { ...typography.caption, fontSize: 12.5 },
  hint: { ...typography.caption, fontSize: 11, marginTop: spacing.sm, textAlign: 'right' },
});

const WealthPostureCardMemo = React.memo(WealthPostureCard);
export { WealthPostureCardMemo as WealthPostureCard };
