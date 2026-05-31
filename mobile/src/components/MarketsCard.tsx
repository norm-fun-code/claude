import React from 'react';
import { View, Text, StyleSheet, Linking, TouchableOpacity, useColorScheme } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import type { Markets } from '../hooks/useBriefing';

interface Props {
  markets: Markets | null | undefined;
}

// Claude-written daily market brief (3-5 bullets) from live finance feeds.
export function MarketsCard({ markets }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const brief = markets?.brief;
  const sources = markets?.sources ?? [];
  if (!brief) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, shadow(isDark)]}>
      <SectionHeader emoji="📰" title="Market Brief" />
      <Markdown style={markdownStyles(c)}>{brief}</Markdown>

      {sources.length > 0 && (
        <View style={[styles.sources, { borderTopColor: c.border }]}>
          <Text style={[styles.sourcesLabel, { color: c.subtext }]}>SOURCES</Text>
          {sources.map((s, i) => (
            <TouchableOpacity
              key={i}
              activeOpacity={s.url ? 0.6 : 1}
              onPress={() => s.url && Linking.openURL(s.url)}
            >
              <Text style={[styles.sourceItem, { color: c.subtext }]} numberOfLines={1}>
                · {s.title} <Text style={{ color: c.subtext }}>({s.source})</Text>
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

function markdownStyles(c: ReturnType<typeof getColors>) {
  return {
    body: { color: c.text, fontSize: 15, lineHeight: 22 },
    bullet_list: { marginVertical: 2 },
    list_item: { marginVertical: 3 },
    strong: { fontWeight: '700', color: c.text },
    paragraph: { marginTop: 0, marginBottom: 6 },
  } as any;
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  sources: { marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1 },
  sourcesLabel: { ...typography.label, fontSize: 9, marginBottom: 4 },
  sourceItem: { fontSize: 12, lineHeight: 18, marginBottom: 1 },
});
