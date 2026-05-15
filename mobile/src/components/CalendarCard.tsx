import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';
import type { CalendarEvent } from '../hooks/useBriefing';

interface Props {
  events: CalendarEvent[];
}

export function CalendarCard({ events }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="📅" title="Today's Calendar" />

      {events.length === 0 ? (
        <Text style={[styles.empty, { color: c.subtext }]}>
          No events today — a clear day. Make it count.
        </Text>
      ) : (
        events.map((event, index) => (
          <View key={index}>
            {index > 0 && <View style={[styles.divider, { backgroundColor: c.border }]} />}
            <View style={styles.eventRow}>
              <View style={[styles.timeBlock, { backgroundColor: isDark ? '#2A2A28' : '#F3F3F0' }]}>
                {event.allDay ? (
                  <Text style={[styles.allDay, { color: c.subtext }]}>All Day</Text>
                ) : (
                  <>
                    <Text style={[styles.time, { color: c.text }]}>{event.startTime}</Text>
                    {event.endTime && (
                      <Text style={[styles.timeEnd, { color: c.subtext }]}>{event.endTime}</Text>
                    )}
                  </>
                )}
              </View>
              <View style={styles.eventDetails}>
                <Text style={[styles.eventTitle, { color: c.text }]} numberOfLines={2}>
                  {event.title}
                </Text>
                {event.location && (
                  <Text style={[styles.location, { color: c.subtext }]} numberOfLines={1}>
                    📍 {event.location}
                  </Text>
                )}
              </View>
            </View>
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
  empty: {
    ...typography.body,
    fontStyle: 'italic',
    paddingVertical: spacing.xs,
  },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  timeBlock: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    minWidth: 72,
    alignItems: 'center',
  },
  time: {
    ...typography.caption,
    fontSize: 13,
    fontWeight: '600',
  },
  timeEnd: {
    ...typography.caption,
    fontSize: 11,
  },
  allDay: {
    ...typography.caption,
    fontSize: 11,
    fontStyle: 'italic',
  },
  eventDetails: {
    flex: 1,
    justifyContent: 'center',
  },
  eventTitle: {
    ...typography.body,
    fontWeight: '500',
  },
  location: {
    ...typography.caption,
    marginTop: spacing.xs,
  },
  divider: {
    height: 1,
    marginHorizontal: -spacing.xs,
  },
});
