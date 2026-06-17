import React from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import type { CalendarEvent, WorkBusyBlock } from '../hooks/useBriefing';

interface Props {
  events: CalendarEvent[];
  workBusy?: WorkBusyBlock[];
}

interface MergedItem {
  kind: 'personal' | 'meeting' | 'allday';
  title: string | null;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  sortMin: number;
}

function parseTimeMin(t: string | null): number {
  if (!t) return -1;
  const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return -1;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

function buildItems(events: CalendarEvent[], workBusy: WorkBusyBlock[]): MergedItem[] {
  const allDay: MergedItem[] = events
    .filter((e) => e.allDay)
    .map((e) => ({ kind: 'allday', title: e.title, startTime: null, endTime: null, location: e.location, sortMin: -1 }));

  const personal: MergedItem[] = events
    .filter((e) => !e.allDay)
    .map((e) => ({
      kind: 'personal',
      title: e.title,
      startTime: e.startTime,
      endTime: e.endTime,
      location: e.location,
      sortMin: parseTimeMin(e.startTime),
    }));

  const meetings: MergedItem[] = workBusy.map((b) => ({
    kind: 'meeting',
    title: null,
    startTime: b.start,
    endTime: b.end,
    location: null,
    sortMin: parseTimeMin(b.start),
  }));

  const timed = [...personal, ...meetings].sort((a, b) => a.sortMin - b.sortMin);
  return [...allDay, ...timed];
}

export function CalendarCard({ events, workBusy = [] }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const items = buildItems(events, workBusy);
  const isEmpty = items.length === 0;

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="📅" title="Today's Calendar" />

      {isEmpty ? (
        <Text style={[styles.empty, { color: c.subtext }]}>
          No events today — a clear day. Make it count.
        </Text>
      ) : (
        items.map((item, index) => (
          <View key={index}>
            {index > 0 && <View style={[styles.divider, { backgroundColor: c.border }]} />}
            <View style={styles.eventRow}>
              <View style={[styles.timeBlock, { backgroundColor: isDark ? '#2A2A28' : '#F3F3F0' }]}>
                {item.kind === 'allday' ? (
                  <Text style={[styles.allDay, { color: c.subtext }]}>All Day</Text>
                ) : (
                  <>
                    <Text style={[styles.time, { color: c.text }]}>{item.startTime}</Text>
                    {item.endTime && (
                      <Text style={[styles.timeEnd, { color: c.subtext }]}>{item.endTime}</Text>
                    )}
                  </>
                )}
              </View>
              <View style={styles.eventDetails}>
                {item.kind === 'meeting' ? (
                  <Text style={[styles.meetingTitle, { color: c.subtext }]}>Meeting</Text>
                ) : (
                  <Text style={[styles.eventTitle, { color: c.text }]} numberOfLines={2}>
                    {item.title}
                  </Text>
                )}
                {item.location && (
                  <Text style={[styles.location, { color: c.subtext }]} numberOfLines={1}>
                    📍 {item.location}
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
    minWidth: 80,
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
  meetingTitle: {
    ...typography.body,
    fontStyle: 'italic',
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
