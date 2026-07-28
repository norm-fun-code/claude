import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, withAlpha, statusColor, type SemanticStatus } from '../theme';

interface Props {
  label: string;
  status: SemanticStatus;
}

/**
 * A small colored status pill — the semantic-status contract's UI leaf.
 * Consolidates the app's many independently-inlined `<View
 * style={{borderRadius:999,...}}><Text>...</Text></View>` badges (several
 * of which didn't even use `radius.pill`) into one component reading a
 * single shared color per severity tier.
 */
function StatusPill({ label, status }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const color = statusColor(status, c);
  return (
    <View style={[styles.pill, { backgroundColor: withAlpha(color, 0.14) }]}>
      <Text style={[styles.label, { color }]} allowFontScaling>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { alignSelf: 'flex-start', borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  label: { ...typography.caption, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3 },
});

export default React.memo(StatusPill);
