import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import { getColors, spacing, radius, shadow } from '../theme';
import { EXPERIMENTS_URL, authHeaders, fetchWithTimeout } from '../config';

type Exp = {
  id: number;
  hypothesis: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
};

function daysElapsed(d: string | null) {
  if (!d) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000));
}

function totalDays(s: string | null, e: string | null) {
  if (!s || !e) return null;
  return Math.round((new Date(e).getTime() - new Date(s).getTime()) / 86400000);
}

export function ActiveExperimentBanner() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [active, setActive] = useState<Exp[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchWithTimeout(EXPERIMENTS_URL, { headers: authHeaders() });
        if (!res.ok) return;
        const { experiments = [] } = await res.json();
        setActive((experiments as Exp[]).filter((e) => e.status === 'running'));
      } catch {}
    })();
  }, []);

  if (active.length === 0) return null;

  const exp = active[0];
  const elapsed = daysElapsed(exp.start_date);
  const total = totalDays(exp.start_date, exp.end_date);
  const progress = total && total > 0 ? Math.min(1, elapsed / total) : 0;

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <View style={styles.header}>
        <View style={[styles.badge, { backgroundColor: c.accentSoft }]}>
          <Text style={[styles.badgeText, { color: c.accent }]}>
            {active.length === 1 ? 'EXPERIMENT RUNNING' : `${active.length} EXPERIMENTS RUNNING`}
          </Text>
        </View>
        {total !== null && (
          <Text style={[styles.dayCount, { color: c.subtext }]}>Day {elapsed}/{total}</Text>
        )}
      </View>
      <Text style={[styles.hypothesis, { color: c.text }]} numberOfLines={2}>
        {exp.hypothesis}
      </Text>
      {total !== null && (
        <View style={[styles.track, { backgroundColor: c.border }]}>
          <View
            style={[
              styles.fill,
              { backgroundColor: c.accent, width: `${Math.round(progress * 100)}%` as any },
            ]}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
  badge: { borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  dayCount: { fontSize: 12, fontWeight: '500' },
  hypothesis: { fontSize: 14, fontWeight: '600', lineHeight: 20, marginBottom: spacing.sm },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
});
