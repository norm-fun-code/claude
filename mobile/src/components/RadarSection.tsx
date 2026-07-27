import React from 'react';
import { View, Text, Pressable, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { presentationForAttentionClass } from '../lib/radarPresentation';
import type { RadarCard } from '../hooks/useBriefing';

interface Props {
  radar: RadarCard[];
  onOpen: (card: RadarCard) => void;
}

const DOMAIN_LABEL: Record<string, string> = {
  health: 'HEALTH',
  wealth: 'WEALTH',
  review: 'REVIEW',
};

// "On My Radar" — server-ranked replacement for the old fixed three-tile
// Health/Wealth/Review preview row (see backend brain/radar.js). Full-width,
// editorial cards — never narrow columns, never more than what the server
// decided is worth attention (0-2 normally, a 3rd only when the server
// flagged it genuinely urgent). Color/label come ONLY from the server's
// `attentionClass` via radarPresentation.ts — this component never invents
// severity from card position or domain. Tapping a card opens the full
// detail sheet (App.tsx owns that state) — this component never navigates
// directly, matching every other Today section's "server decides, mobile
// renders" contract.
function RadarSection({ radar, onOpen }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!radar || radar.length === 0) {
    // Truthful quiet state (Part 6) — never an empty card grid, never
    // silence either; a deliberate, calm confirmation that nothing was
    // suppressed for lack of checking.
    return (
      <View style={styles.quietWrap}>
        <Text style={[styles.quietText, { color: c.subtext }]}>Everything else looks on track.</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <Text style={[styles.header, { color: c.subtext }]}>
        ON MY RADAR · {radar.length} {radar.length === 1 ? 'ITEM' : 'ITEMS'}
      </Text>
      {radar.map((card) => {
        const presentation = presentationForAttentionClass(card.attentionClass);
        const dotColor = c[presentation.colorToken] ?? c.subtext;
        return (
          <Pressable
            key={card.stableId}
            onPress={() => onOpen(card)}
            accessibilityRole="button"
            accessibilityLabel={`${presentation.label}. ${card.headline}. ${card.whyNow ?? ''}`}
            style={({ pressed }) => [
              styles.card, { backgroundColor: c.card, opacity: pressed ? 0.85 : 1 }, shadow(isDark),
            ]}
          >
            <View style={styles.topRow}>
              <View style={[styles.dot, { backgroundColor: dotColor }]} />
              <Text style={[styles.domain, { color: c.subtext }]}>{DOMAIN_LABEL[card.domain] ?? card.domain.toUpperCase()}</Text>
            </View>
            <Text style={[styles.headline, { color: c.text }]}>{card.headline}</Text>
            {card.whyNow ? (
              <Text style={[styles.whyNow, { color: c.subtext }]} numberOfLines={3}>{card.whyNow}</Text>
            ) : null}
            <Text style={[styles.cta, { color: c.accent }]}>{card.actionLabel} →</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.md },
  header: { fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: spacing.sm },
  quietWrap: { paddingVertical: spacing.sm, marginBottom: spacing.md, alignItems: 'center' },
  quietText: { ...typography.caption, fontSize: 13 },
  card: {
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
    minHeight: 44,
  },
  topRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  dot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },
  domain: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },
  headline: { ...typography.subtitle, fontSize: 16, lineHeight: 21, marginBottom: 4 },
  whyNow: { ...typography.body, fontSize: 13, lineHeight: 18, marginBottom: spacing.sm },
  cta: { fontSize: 13, fontWeight: '700' },
});

const RadarSectionMemo = React.memo(RadarSection);
export { RadarSectionMemo as RadarSection };
