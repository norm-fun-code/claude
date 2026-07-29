import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow, colors as themeColors, FONTS } from '../theme';
import type { WealthLanding } from '../hooks/useBriefing';
import { paceLine, driverLine } from '../lib/wealthPaceCopy';
import { positionTone, compactMoney } from '../lib/wealthPositionTone';
import { formatMoney as money } from '../lib/format';
import { SkeletonCard } from './viz/Skeleton';

interface Props {
  landing: WealthLanding | null | undefined;
  // Secondary exception affordance ("N categories stand out →") — scrolls to
  // the Worth-a-look card rather than reloading the tab. Omitted (affordance
  // hidden) when there's nothing to scroll to.
  onViewExceptions?: () => void;
}

/**
 * Wealth hierarchy redesign — the ONE dominant, premium "financial posture"
 * card leading the Wealth landing page, structured Eyebrow → Primary
 * conclusion → Primary amount → Comparison line → Compact supporting
 * metrics → Secondary exception affordance. The primary conclusion
 * (landing.positionConclusion) is the household's overall monthly
 * trajectory and is DELIBERATELY independent of landing.severity/
 * exceptionCount below it — a healthy trajectory must read as healthy even
 * when a category or two stands out; amber only ever appears on the
 * secondary affordance and on individual category rows (WealthWhatChangedCard),
 * never on the overall position. All numbers are server-computed
 * (backend/src/services/wealth-landing.js) — never re-derived here.
 */
function WealthPostureCard({ landing, onViewExceptions }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [hidden, setHidden] = React.useState(false);

  if (!landing) {
    // A pulsing skeleton (not bare "Loading…" text) so this never reads as
    // blank/failed content while the Wealth landing projection is in flight.
    return <SkeletonCard rows={4} isDark={isDark} tall />;
  }

  const { numbers, sourceHealth, positionConclusion, exceptionCount } = landing;
  const mask = (s: string) => (hidden ? '••••' : s);
  // Secondary body text bumped for dark-mode legibility (audit item 6) —
  // theme.ts's named `subtextStrong` token, not a local magic value.
  const secondary = c.subtextStrong;
  // Backward compatible with a landing payload cached before positionConclusion
  // existed — falls back to the old deterministic summary line, never a blank.
  const headline = positionConclusion?.headline ?? landing.summary;
  const tone = positionTone(headline);

  const comparison = numbers.mtdDiscretionary?.comparison ?? null;
  const compactMetrics: { label: string; tone?: string }[] = [];
  if (numbers.savingsRate) {
    compactMetrics.push({ label: `${numbers.savingsRate.ratePct}% saved`, tone: numbers.savingsRate.healthy ? themeColors.green : undefined });
  }
  if (numbers.planPace) {
    compactMetrics.push({
      label: `${numbers.planPace.ahead ? '+' : '-'}${compactMoney(Math.abs(numbers.planPace.delta))} ${numbers.planPace.ahead ? 'ahead of' : 'behind'} plan`,
      tone: numbers.planPace.ahead ? themeColors.green : undefined,
    });
  }
  if (numbers.netWorth) {
    compactMetrics.push({ label: `${compactMoney(numbers.netWorth.amount)} net worth` });
  }
  if (numbers.cashBuffer && (numbers.cashBuffer.thin || numbers.cashBuffer.critical)) {
    compactMetrics.push({
      label: `${compactMoney(numbers.cashBuffer.amount)} cash buffer`,
      tone: numbers.cashBuffer.critical ? themeColors.red : themeColors.amber,
    });
  }

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <Text style={[styles.eyebrow, { color: secondary }]}>MONTHLY POSITION</Text>

      <Text style={[styles.postureLabel, { color: tone }]} accessibilityRole="header">
        {headline}{positionConclusion?.provisional ? ' (provisional)' : ''}
      </Text>

      {sourceHealth.qualification ? (
        <Text style={[styles.qualification, { color: secondary }]}>{sourceHealth.qualification}</Text>
      ) : null}

      <View onTouchEnd={() => setHidden((h) => !h)} accessibilityRole="button" accessibilityLabel={hidden ? 'Show amounts' : 'Hide amounts'} accessibilityHint="Double tap to toggle privacy mask">
        {numbers.mtdDiscretionary ? (
          <View style={styles.paceBlock}>
            <Text style={[styles.primaryAmount, { color: c.text }]} allowFontScaling>
              {mask(money(numbers.mtdDiscretionary.amount))} <Text style={[styles.primaryAmountLabel, { color: secondary }]}>MTD</Text>
            </Text>
            {comparison ? (
              <Text style={[styles.paceLine, { color: secondary }]} allowFontScaling>
                {mask(paceLine(comparison))}
              </Text>
            ) : null}
            {comparison && driverLine(comparison.drivers) ? (
              <Text style={[styles.paceLine, { color: secondary }]} allowFontScaling>{mask(driverLine(comparison.drivers)!)}</Text>
            ) : null}
          </View>
        ) : null}

        {compactMetrics.length ? (
          <View style={styles.metricsRow}>
            {compactMetrics.map((m, i) => (
              <Text key={i} style={[styles.metricChip, { color: m.tone ?? c.text, borderColor: c.border }]} allowFontScaling>
                {mask(m.label)}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
      <Text style={[styles.hint, { color: secondary }]}>{hidden ? 'tap to show' : 'tap to hide'}</Text>

      {exceptionCount != null && exceptionCount > 0 ? (
        <TouchableOpacity
          onPress={onViewExceptions}
          disabled={!onViewExceptions}
          hitSlop={8}
          style={styles.exceptionsRow}
          accessibilityRole="button"
          accessibilityLabel={`${exceptionCount} ${exceptionCount === 1 ? 'category stands' : 'categories stand'} out`}
          accessibilityHint="Scrolls to the categories worth a look"
        >
          <Text style={[styles.exceptionsText, { color: themeColors.amber }]}>
            {exceptionCount} {exceptionCount === 1 ? 'category' : 'categories'} stand out ›
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  eyebrow: { ...typography.caption, fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  postureLabel: { fontFamily: FONTS.display, fontSize: 21, fontWeight: '700', letterSpacing: -0.3, marginTop: 2 },
  qualification: { ...typography.caption, fontSize: 13, marginTop: spacing.xs, fontStyle: 'italic' },
  primaryAmount: { fontFamily: FONTS.display, fontSize: 28, fontWeight: '700', letterSpacing: -0.4, marginTop: spacing.md },
  primaryAmountLabel: { fontSize: 14, fontWeight: '600' },
  paceBlock: { gap: 2 },
  paceLine: { ...typography.caption, fontSize: 12.5, marginTop: 2 },
  metricsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  metricChip: { ...typography.caption, fontSize: 12.5, fontWeight: '600', borderWidth: 1, borderRadius: radius.sm, paddingVertical: 4, paddingHorizontal: 8 },
  hint: { ...typography.caption, fontSize: 11, marginTop: spacing.sm, textAlign: 'right' },
  exceptionsRow: { marginTop: spacing.sm, minHeight: 44, justifyContent: 'center' },
  exceptionsText: { ...typography.subtitle, fontSize: 14, fontWeight: '600' },
});

const WealthPostureCardMemo = React.memo(WealthPostureCard);
export { WealthPostureCardMemo as WealthPostureCard };
