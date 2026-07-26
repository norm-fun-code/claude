import React from 'react';
import { View, Text, Pressable, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import type { TodayPreview } from '../hooks/useBriefing';

interface Props {
  previews: TodayPreview[];
  onNavigate: (destination: string) => void;
}

const DOMAIN_LABEL: Record<string, string> = {
  health: 'HEALTH',
  wealth: 'WEALTH',
  review: 'REVIEW',
};

// Optional previews — at most one compact row per domain (server-decided,
// see backend brain/todayCommandCenter.js's buildPreviews). Each links to
// its authoritative destination rather than reproducing the full domain
// card here. Self-hides entirely when nothing deserves attention.
function PreviewsRow({ previews, onNavigate }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!previews || previews.length === 0) return null;

  return (
    <View style={styles.wrap}>
      {previews.map((p) => (
        <Pressable
          key={p.domain}
          onPress={() => onNavigate(p.destination)}
          style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}
        >
          <Text style={[styles.domain, { color: c.subtext }]}>{DOMAIN_LABEL[p.domain] ?? p.domain.toUpperCase()}</Text>
          <Text style={[styles.title, { color: c.text }]} numberOfLines={2}>{p.title}</Text>
          {p.summary ? <Text style={[styles.summary, { color: c.subtext }]} numberOfLines={2}>{p.summary}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  card: {
    flexGrow: 1,
    flexBasis: '30%',
    borderRadius: radius.lg,
    padding: spacing.sm + 2,
    minHeight: 44,
  },
  domain: { fontSize: 9, fontWeight: '700', letterSpacing: 0.8, marginBottom: 3 },
  title: { ...typography.body, fontSize: 13, fontWeight: '600', lineHeight: 17 },
  summary: { ...typography.caption, fontSize: 11, marginTop: 2, lineHeight: 14 },
});

const PreviewsRowMemo = React.memo(PreviewsRow);
export { PreviewsRowMemo as PreviewsRow };
