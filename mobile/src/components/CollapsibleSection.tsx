import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, useColorScheme } from 'react-native';
import { getColors, spacing, radius } from '../theme';

interface Props {
  title: string;
  /** Open on first render. Default collapsed — the point is to hide the stack. */
  defaultOpen?: boolean;
  children: React.ReactNode;
}

// A tap-to-expand wrapper. In the Chief-of-Staff Today vision, the brief sits on
// top and the full card stack lives inside one of these — visible on demand, not
// a wall by default.
export function CollapsibleSection({ title, defaultOpen = false, children }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [open, setOpen] = useState(defaultOpen);

  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        onPress={() => setOpen((v) => !v)}
        activeOpacity={0.7}
        style={[styles.header, { borderColor: c.border, backgroundColor: c.card }]}
      >
        <Text style={[styles.title, { color: c.text }]}>{title}</Text>
        <Text style={[styles.chevron, { color: c.subtext }]}>{open ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {open && <View style={styles.body}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.md },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  title: { fontSize: 14, fontWeight: '600', letterSpacing: 0.2 },
  chevron: { fontSize: 11 },
  body: { marginTop: spacing.md },
});
