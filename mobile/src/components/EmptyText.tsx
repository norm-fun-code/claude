import React from 'react';
import { Text, StyleSheet, TextStyle, useColorScheme } from 'react-native';
import { getColors, typography } from '../theme';

interface Props {
  children: React.ReactNode;
  center?: boolean;
  style?: TextStyle;
}

/**
 * The small "nothing to show yet" line used inside a card body — e.g. "No
 * categorized spending yet this month," "Nothing learned yet." Consolidates
 * ~7 near-identical hand-styled instances that disagreed on italic/size/
 * token (some `caption`, some `body`, some 12/13/14px, some italic some
 * not) into one consistent treatment. For a whole-card empty state (no
 * content at all, not just an empty list inside a populated card), use the
 * existing `EmptyNote` in App.tsx instead — this is the in-card variant.
 */
function EmptyText({ children, center, style }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  return (
    <Text
      style={[styles.text, { color: c.subtext }, center ? styles.center : null, style]}
      allowFontScaling
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: { ...typography.caption, fontStyle: 'italic' },
  center: { textAlign: 'center' },
});

export default React.memo(EmptyText);
