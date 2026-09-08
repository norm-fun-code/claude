import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow, withAlpha, tileTint } from '../theme';
import { FullScreenSheet } from './FullScreenSheet';
import {
  stateSummary,
  headlineCount,
  comparisonLines,
  methodNote,
  formatDay,
  formatDelta,
  formatWindow,
  closestWithOutcome,
  COMPARISON_CAVEAT,
  type Precedent,
} from '../lib/precedentCopy';

const ET_TZ = 'America/New_York';

interface Props {
  precedent: Precedent | null;
}

/**
 * "You've been here before."
 *
 * Every other card on Today describes the present. This one is the only place
 * the app reasons from the user's own past: it retrieves the mornings most
 * like this one out of the metrics spine, and reports what actually happened
 * after them.
 *
 * Presentation rules, all inherited from the same truth-and-evidence contract
 * the rest of the app holds:
 *
 *   * Self-hiding. A null precedent means the server's evidence gates were
 *     not met, and the card renders nothing at all — no "not enough data yet"
 *     placeholder, which would be a card about the absence of a card.
 *   * Never advice. The comparison shows two measured outcomes side by side
 *     and says so explicitly; it never marks one as the recommended choice,
 *     and the arms are ordered lighter-then-harder (fixed) rather than
 *     best-then-worst, so the layout itself cannot imply a preference.
 *   * Always checkable. Real dates, on the card and in full in the detail
 *     sheet, so any claim here can be verified against memory.
 */
function PrecedentCard({ precedent }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [detailOpen, setDetailOpen] = useState(false);

  if (!precedent) return null;

  const arms = comparisonLines(precedent.comparison);
  const closest = closestWithOutcome(precedent);
  const summary = stateSummary(precedent.state);
  const accent = tileTint.violet;

  const deltaColor = (direction: 'up' | 'down' | 'flat') =>
    direction === 'up' ? c.green : direction === 'down' ? c.red : c.subtext;

  return (
    <>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => setDetailOpen(true)}
        style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}
      >
        <View style={styles.header}>
          <View style={[styles.badge, { backgroundColor: withAlpha(accent, isDark ? 0.22 : 0.14) }]}>
            <Text style={[styles.badgeText, { color: accent }]}>FROM YOUR OWN HISTORY</Text>
          </View>
          <Text style={[styles.title, { color: c.text }]}>You’ve been here before</Text>
          <Text style={[styles.count, { color: c.subtext }]}>
            {headlineCount(precedent.count)} · {formatWindow(precedent, ET_TZ)}
          </Text>
        </View>

        {summary ? <Text style={[styles.summary, { color: c.text }]}>{summary}</Text> : null}

        {arms ? (
          <View style={[styles.comparison, { borderTopColor: c.border }]}>
            {arms.map((arm) => (
              <View key={arm.label} style={styles.armRow}>
                <Text style={[styles.armLabel, { color: c.text }]} numberOfLines={2}>
                  {arm.label}
                </Text>
                <Text style={[styles.armDelta, { color: deltaColor(arm.direction) }]}>{arm.delta}</Text>
              </View>
            ))}
            <Text style={[styles.armUnit, { color: c.subtext }]}>
              average next-day recovery movement
            </Text>
          </View>
        ) : closest ? (
          <View style={[styles.comparison, { borderTopColor: c.border }]}>
            <Text style={[styles.closest, { color: c.subtext }]}>
              Closest match {formatDay(closest.day, ET_TZ)} ({closest.similarity}% similar) — recovery moved{' '}
              <Text style={{ color: closest.nextDayDelta! >= 0 ? c.green : c.red, fontWeight: '700' }}>
                {formatDelta(closest.nextDayDelta!)}
              </Text>{' '}
              the next day.
            </Text>
          </View>
        ) : null}

        <Text style={[styles.more, { color: accent }]}>See all {precedent.count} days ›</Text>
      </TouchableOpacity>

      <FullScreenSheet
        visible={detailOpen}
        title="You’ve been here before"
        onClose={() => setDetailOpen(false)}
      >
        <View style={[styles.sheetCard, { backgroundColor: c.card }, shadow(isDark)]}>
          <Text style={[styles.sheetHeading, { color: c.text }]}>What today looks like</Text>
          {precedent.state.map((s) => (
            <View key={s.key} style={styles.stateRow}>
              <Text style={[styles.stateLabel, { color: c.subtext }]}>{s.label}</Text>
              <Text style={[styles.stateValue, { color: c.text }]}>
                {s.value ?? '—'}
                <Text style={[styles.stateZ, { color: c.subtext }]}>
                  {'  '}
                  {s.z >= 0 ? '+' : '−'}
                  {Math.abs(s.z).toFixed(1)}σ
                </Text>
              </Text>
            </View>
          ))}
          <Text style={[styles.method, { color: c.subtext }]}>{methodNote(precedent, ET_TZ)}</Text>
        </View>

        {arms ? (
          <View style={[styles.sheetCard, { backgroundColor: c.card }, shadow(isDark)]}>
            <Text style={[styles.sheetHeading, { color: c.text }]}>What happened next</Text>
            {arms.map((arm) => (
              <View key={arm.label} style={styles.armBlock}>
                <View style={styles.armRow}>
                  <Text style={[styles.armLabel, { color: c.text }]}>{arm.label}</Text>
                  <Text style={[styles.armDelta, { color: deltaColor(arm.direction) }]}>{arm.delta}</Text>
                </View>
                <Text style={[styles.armDays, { color: c.subtext }]}>
                  {arm.days.map((d) => formatDay(d, ET_TZ)).join(' · ')}
                </Text>
              </View>
            ))}
            <Text style={[styles.caveat, { color: c.subtext }]}>{COMPARISON_CAVEAT}</Text>
          </View>
        ) : null}

        <View style={[styles.sheetCard, { backgroundColor: c.card }, shadow(isDark)]}>
          <Text style={[styles.sheetHeading, { color: c.text }]}>
            The {precedent.count} closest mornings
          </Text>
          <View style={[styles.tableHead, { borderBottomColor: c.border }]}>
            <Text style={[styles.thDay, { color: c.subtext }]}>DAY</Text>
            <Text style={[styles.thNum, { color: c.subtext }]}>MATCH</Text>
            <Text style={[styles.thNum, { color: c.subtext }]}>REC</Text>
            <Text style={[styles.thNum, { color: c.subtext }]}>NEXT DAY</Text>
          </View>
          {precedent.precedents.map((p) => (
            <View key={p.day} style={[styles.tableRow, { borderBottomColor: c.border }]}>
              <Text style={[styles.tdDay, { color: c.text }]}>{formatDay(p.day, ET_TZ)}</Text>
              <Text style={[styles.tdNum, { color: c.subtext }]}>{p.similarity}%</Text>
              <Text style={[styles.tdNum, { color: c.subtext }]}>{p.recovery ?? '—'}</Text>
              <Text
                style={[
                  styles.tdNum,
                  { color: p.nextDayDelta == null ? c.subtext : p.nextDayDelta >= 0 ? c.green : c.red },
                ]}
              >
                {p.nextDayDelta == null ? '—' : formatDelta(p.nextDayDelta)}
              </Text>
            </View>
          ))}
          <Text style={[styles.method, { color: c.subtext }]}>
            {precedent.evidence.withOutcome} of these {precedent.count} days have a recorded next-day
            reading; the rest are shown but not counted in any average.
          </Text>
        </View>
      </FullScreenSheet>
    </>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  header: { marginBottom: spacing.sm },
  badge: { alignSelf: 'flex-start', paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: 10, marginBottom: spacing.xs },
  badgeText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.8 },
  title: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3, marginBottom: 2 },
  count: { fontSize: 12, fontWeight: '600' },
  summary: { ...typography.body, fontSize: 14, lineHeight: 20 },
  comparison: { borderTopWidth: 1, marginTop: spacing.sm, paddingTop: spacing.sm },
  armRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  armLabel: { flex: 1, fontSize: 14, fontWeight: '600', lineHeight: 19 },
  armDelta: { fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  armUnit: { fontSize: 11, marginTop: 4, fontStyle: 'italic' },
  armBlock: { marginBottom: spacing.sm },
  armDays: { fontSize: 11, marginTop: 2 },
  closest: { ...typography.body, fontSize: 13, lineHeight: 19 },
  more: { fontSize: 12, fontWeight: '700', marginTop: spacing.sm },
  sheetCard: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  sheetHeading: { fontSize: 15, fontWeight: '700', marginBottom: spacing.sm },
  stateRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingVertical: 4 },
  stateLabel: { fontSize: 13 },
  stateValue: { fontSize: 15, fontWeight: '700' },
  stateZ: { fontSize: 11, fontWeight: '600' },
  method: { fontSize: 11, lineHeight: 16, marginTop: spacing.sm, fontStyle: 'italic' },
  caveat: { fontSize: 11, lineHeight: 16, marginTop: spacing.xs, fontStyle: 'italic' },
  tableHead: { flexDirection: 'row', borderBottomWidth: 1, paddingBottom: 6 },
  tableRow: { flexDirection: 'row', borderBottomWidth: 1, paddingVertical: 8 },
  thDay: { flex: 1.4, fontSize: 9, fontWeight: '700', letterSpacing: 0.6 },
  thNum: { flex: 1, fontSize: 9, fontWeight: '700', letterSpacing: 0.6, textAlign: 'right' },
  tdDay: { flex: 1.4, fontSize: 13, fontWeight: '600' },
  tdNum: { flex: 1, fontSize: 13, textAlign: 'right', fontVariant: ['tabular-nums'] },
});

const PrecedentCardMemo = React.memo(PrecedentCard);
export { PrecedentCardMemo as PrecedentCard };
