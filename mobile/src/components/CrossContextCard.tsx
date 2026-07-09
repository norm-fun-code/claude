import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { Insight } from '../hooks/useBriefing';

interface Props {
  insights: Insight[];
}

const DOMAIN_COLORS: Record<string, string> = {
  sleep: '#5B7FFF',
  health: '#00A86B',
  habits: '#F59E0B',
  finance: '#8B5CF6',
  wealth: '#8B5CF6',
  mood: '#EC4899',
  focus: '#06B6D4',
  energy: '#F97316',
  activity: '#10B981',
  recovery: '#3B82F6',
};

function domainColor(domain: string): string {
  const key = domain.toLowerCase();
  return DOMAIN_COLORS[key] ?? '#635BFF';
}

function CrossContextCard({ insights }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  if (!insights || insights.length === 0) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <View style={styles.header}>
        <View style={[styles.badge, { backgroundColor: c.accentSoft }]}>
          <Text style={[styles.badgeText, { color: c.accent }]}>CONNECTED BY NORMOS</Text>
        </View>
        <Text style={[styles.title, { color: c.text }]}>Cross-Domain Patterns</Text>
        <Text style={[styles.subtitle, { color: c.subtext }]}>
          Connections across your health, habits, and finances that most apps miss
        </Text>
      </View>

      {insights.map((ins, i) => (
        <View
          key={i}
          style={[
            styles.insight,
            { borderTopColor: c.border },
            i > 0 && styles.insightBorder,
          ]}
        >
          <Text style={[styles.headline, { color: c.text }]}>{ins.title}</Text>
          {ins.detail ? (
            <Text style={[styles.detail, { color: c.subtext }]}>{ins.detail}</Text>
          ) : null}
          {ins.domains && ins.domains.length > 0 && (
            <View style={styles.domains}>
              {ins.domains.map((d, j) => (
                <View
                  key={j}
                  style={[styles.chip, { backgroundColor: domainColor(d) + '18' }]}
                >
                  <Text style={[styles.chipText, { color: domainColor(d) }]}>
                    {d.toUpperCase()}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  header: {
    marginBottom: spacing.sm,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: 10,
    marginBottom: spacing.xs,
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.3,
    marginBottom: 4,
  },
  subtitle: {
    ...typography.body,
    fontSize: 13,
    lineHeight: 18,
  },
  insight: {
    paddingTop: spacing.sm,
    marginTop: spacing.sm,
  },
  insightBorder: {
    borderTopWidth: 1,
  },
  headline: {
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 21,
    marginBottom: 4,
  },
  detail: {
    ...typography.body,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: spacing.xs,
  },
  domains: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
  },
  chip: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 8,
  },
  chipText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
});

const CrossContextCardMemo = React.memo(CrossContextCard);
export { CrossContextCardMemo as CrossContextCard };
