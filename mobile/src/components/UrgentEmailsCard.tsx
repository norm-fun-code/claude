import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, colors } from '../theme';
import { SectionHeader } from './SectionHeader';
import type { UrgentEmail } from '../hooks/useBriefing';

interface Props {
  emails: UrgentEmail[];
}

export function UrgentEmailsCard({ emails }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="🚨" title="Urgent Inbox" />

      {emails.length === 0 ? (
        <Text style={[styles.clear, { color: c.subtext }]}>Inbox clear. No urgent actions required.</Text>
      ) : (
        emails.map((email, index) => (
          <View
            key={index}
            style={[
              styles.emailRow,
              { borderLeftColor: colors.red, backgroundColor: isDark ? '#1A1A18' : '#FAFAF8' },
            ]}
          >
            <Text style={[styles.from, { color: c.subtext }]}>{email.from}</Text>
            <Text style={[styles.subject, { color: c.text }]}>{email.subject}</Text>
            <Text style={[styles.action, { color: c.subtext }]}>{email.action}</Text>
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  clear: {
    ...typography.body,
    fontStyle: 'italic',
    paddingVertical: spacing.xs,
  },
  emailRow: {
    borderLeftWidth: 3,
    borderRadius: radius.sm,
    paddingLeft: spacing.sm,
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
  },
  from: {
    ...typography.caption,
    fontSize: 11,
    marginBottom: 2,
  },
  subject: {
    ...typography.body,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  action: {
    ...typography.body,
    fontSize: 14,
    lineHeight: 21,
  },
});
