import React from 'react';
import { View, Text, StyleSheet, Switch, useColorScheme } from 'react-native';
import { getColors, spacing, radius, shadow } from '../theme';

interface Props {
  worn: boolean;
  onChange: (worn: boolean) => void;
  saving?: boolean;
}

/**
 * "Wore my Apple Watch today" — on by default.
 *
 * It sits directly under the activity numbers on the Health tab on purpose:
 * this is the moment you notice the steps look wrong, and the fix should be
 * within reach rather than buried in a settings screen.
 *
 * The switch reads POSITIVELY ("Wore my Apple Watch") rather than as the
 * exception it records. A toggle labelled "Didn't wear my watch" is on when
 * something is absent, which takes a beat to parse every single time.
 *
 * The explanatory line only appears once the watch is marked off. In the
 * default state it would be a standing caption explaining a thing that is not
 * happening; in the off state it is the answer to "so what did that do?".
 */
function WatchWearCard({ worn, onChange, saving }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <View style={styles.row}>
        <View style={styles.labelWrap}>
          <Text style={[styles.label, { color: c.text }]}>Wore my Apple Watch</Text>
          <Text style={[styles.sub, { color: c.subtext }]}>
            {worn ? 'Today’s activity counts as measured' : 'Today’s step and energy readings are set aside'}
          </Text>
        </View>
        <Switch
          value={worn}
          onValueChange={onChange}
          disabled={saving}
          trackColor={{ false: c.border, true: c.accent }}
        />
      </View>
      {!worn && (
        // Said plainly because the alternative — silently dropping a day — is
        // exactly the kind of invisible behaviour that makes a number
        // untrustworthy later.
        <Text style={[styles.note, { color: c.subtext }]}>
          Steps, active energy and exercise minutes from the watch are left out of today’s
          trends and baselines. Anything you log yourself still counts, and nothing is deleted —
          switch this back on and the readings return.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  labelWrap: { flex: 1 },
  label: { fontSize: 15, fontWeight: '600' },
  sub: { fontSize: 12, marginTop: 2, lineHeight: 17 },
  note: { fontSize: 11, lineHeight: 16, marginTop: spacing.sm, fontStyle: 'italic' },
});

const WatchWearCardMemo = React.memo(WatchWearCard);
export { WatchWearCardMemo as WatchWearCard };
