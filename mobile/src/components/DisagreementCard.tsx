import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow, withAlpha } from '../theme';
import { missedWeeksLine, basisLine, type Disagreement } from '../lib/disagreementCopy';

const ET_TZ = 'America/New_York';

interface Props {
  disagreement: Disagreement | null;
  onResolve: (choice: 'revise' | 'keep' | 'retire') => void;
  resolving?: boolean;
}

/**
 * The one card in NormOS that says something you don't want to hear.
 *
 * Design rules, all of which exist to keep it on the right side of a very fine
 * line:
 *
 *   * It is never dismissible-by-ignoring. There is no ✕. The only way past it
 *     is to answer the question, because the question is the point — and all
 *     three answers are legitimate, so answering costs nothing but a decision.
 *   * It is styled NEUTRALLY, not as an alert. Red would make it a failure
 *     notice; this is not a failure, it is a mismatch between two things you
 *     said, and either one of them may be the thing that's wrong.
 *   * The counts carry the weight. No adjectives, no emoji, no exclamation —
 *     see lib/disagreementCopy's tone guard, which a test enforces.
 *   * The receipts are on the card, not hidden behind a tap: the actual weeks,
 *     and the fact that this is the reader's own goal text and their own
 *     grading. An unarguable claim doesn't need to hide its working.
 */
function DisagreementCard({ disagreement, onResolve, resolving }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!disagreement) return null;

  const weeks = missedWeeksLine(disagreement, ET_TZ);

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: withAlpha(c.subtext, 0.35) }, shadow(isDark)]}>
      <Text style={[styles.eyebrow, { color: c.subtext }]}>WORTH A DECISION</Text>
      <Text style={[styles.headline, { color: c.text }]}>{disagreement.headline}</Text>
      <Text style={[styles.detail, { color: c.text }]}>{disagreement.detail}</Text>
      {weeks ? <Text style={[styles.weeks, { color: c.subtext }]}>{weeks}</Text> : null}

      <Text style={[styles.question, { color: c.text }]}>{disagreement.question}</Text>

      <View style={styles.options}>
        {disagreement.options.map((opt) => (
          <TouchableOpacity
            key={opt.id}
            disabled={resolving}
            onPress={() => onResolve(opt.id)}
            activeOpacity={0.7}
            style={[styles.option, { borderColor: c.border, backgroundColor: c.background }]}
          >
            <Text style={[styles.optionLabel, { color: c.text }]}>{opt.label}</Text>
            {opt.detail ? (
              <Text style={[styles.optionDetail, { color: c.subtext }]}>{opt.detail}</Text>
            ) : null}
          </TouchableOpacity>
        ))}
      </View>

      {resolving ? <ActivityIndicator style={styles.spinner} color={c.subtext} /> : null}
      <Text style={[styles.basis, { color: c.subtext }]}>{basisLine(disagreement)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // A hairline border rather than a colored fill: this is a decision to make,
  // not an alarm to react to.
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md, borderWidth: 1 },
  eyebrow: { fontSize: 9, fontWeight: '700', letterSpacing: 0.8, marginBottom: spacing.xs },
  headline: { fontSize: 17, fontWeight: '700', lineHeight: 23, letterSpacing: -0.2, marginBottom: 4 },
  detail: { ...typography.body, fontSize: 14, lineHeight: 20 },
  weeks: { fontSize: 12, marginTop: 4 },
  question: { fontSize: 15, fontWeight: '700', marginTop: spacing.md, marginBottom: spacing.sm },
  options: { gap: spacing.xs },
  option: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing.sm + 2, paddingVertical: spacing.sm },
  optionLabel: { fontSize: 14, fontWeight: '600' },
  optionDetail: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  spinner: { marginTop: spacing.sm },
  basis: { fontSize: 11, lineHeight: 16, marginTop: spacing.sm, fontStyle: 'italic' },
});

const DisagreementCardMemo = React.memo(DisagreementCard);
export { DisagreementCardMemo as DisagreementCard };
