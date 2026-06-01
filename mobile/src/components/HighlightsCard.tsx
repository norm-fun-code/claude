import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  useColorScheme,
  Linking,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';
import { HIGHLIGHTS_URL, authHeaders } from '../config';

// Today's date (local) as a cache key, so the set resets at midnight.
const todayKey = () => `normos.highlights.${new Date().toLocaleDateString('en-CA')}`;

interface Highlight {
  id: string;
  text: string;
  title: string | null;
  author: string | null;
  url: string | null;
  favorite: boolean;
}

// Daily Readwise highlights — 5 random (hearted-first) per fetch. Tap "Next" to
// flip through them; refetches a fresh set once you reach the end. Replaces the
// old single "From Your Library" card on the Wisdom tab.
export function HighlightsCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Fetch a fresh set from the server. `persist` caches it as today's set so it
  // stays static across tab switches / reopens until midnight.
  const load = useCallback(async (persist = true) => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`${HIGHLIGHTS_URL}?limit=5`, { headers: authHeaders() });
      const json = await res.json();
      const items = json.highlights ?? [];
      setHighlights(items);
      setIdx(0);
      if (persist && items.length) {
        AsyncStorage.setItem(todayKey(), JSON.stringify(items)).catch(() => {});
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // On mount: reuse today's already-pulled set if we have one (so it's static
  // all day); otherwise pull the first set of the day and cache it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(todayKey());
        if (saved && !cancelled) {
          const items = JSON.parse(saved);
          if (Array.isArray(items) && items.length) {
            setHighlights(items);
            setIdx(0);
            setLoading(false);
            return;
          }
        }
      } catch {
        /* ignore corrupt cache */
      }
      if (!cancelled) load(true);
    })();
    return () => { cancelled = true; };
  }, [load]);

  const next = () => {
    if (idx < highlights.length - 1) setIdx(idx + 1);
    else load(true); // reached the end — pull a fresh set (and make it today's set)
  };

  const back = () => {
    if (idx > 0) setIdx(idx - 1);
  };

  const current = highlights[idx];

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="📚" title="From Your Library" />

      {loading && !current ? (
        <View style={styles.loading}>
          <ActivityIndicator color={c.subtext} />
        </View>
      ) : error || !current ? (
        <Text style={[styles.empty, { color: c.subtext }]}>
          {error ? 'Could not load highlights. Pull to refresh.' : 'No highlights yet.'}
        </Text>
      ) : (
        <>
          <View
            style={[
              styles.quoteBlock,
              { borderLeftColor: c.accent, backgroundColor: isDark ? '#0E2E4D' : '#FAFAF8' },
            ]}
          >
            <Text style={[styles.quoteText, { color: c.text }]}>{current.text}</Text>
          </View>

          <View style={styles.footer}>
            <Text style={[styles.byline, { color: c.subtext }]} numberOfLines={2}>
              {current.favorite ? '♥ ' : ''}
              {current.author
                ? `${current.title ?? 'Untitled'} — ${current.author}`
                : current.title ?? 'Readwise'}
            </Text>
            {current.url ? (
              <TouchableOpacity onPress={() => Linking.openURL(current.url!)}>
                <Text style={[styles.link, { color: c.accent }]}>Open ↗</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          <View style={styles.navRow}>
            <TouchableOpacity
              style={[styles.navBtn, { borderColor: c.border, opacity: idx > 0 ? 1 : 0.35 }]}
              onPress={back}
              disabled={idx === 0}
              activeOpacity={0.7}
            >
              <Text style={[styles.navText, { color: c.accent }]}>‹  Back</Text>
            </TouchableOpacity>

            <Text style={[styles.counter, { color: c.subtext }]}>
              {idx + 1}/{highlights.length}
            </Text>

            <TouchableOpacity
              style={[styles.navBtn, { borderColor: c.border }]}
              onPress={next}
              activeOpacity={0.7}
            >
              <Text style={[styles.navText, { color: c.accent }]}>
                {idx < highlights.length - 1 ? 'Next  ›' : 'New set  ↻'}
              </Text>
            </TouchableOpacity>
          </View>
        </>
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
  loading: { paddingVertical: spacing.lg, alignItems: 'center' },
  empty: { ...typography.body, fontStyle: 'italic', paddingVertical: spacing.sm },
  quoteBlock: {
    borderLeftWidth: 3,
    paddingLeft: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    marginBottom: spacing.sm,
    minHeight: 60,
  },
  quoteText: {
    ...typography.body,
    fontStyle: 'italic',
    lineHeight: 24,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  byline: {
    ...typography.caption,
    fontSize: 13,
    flex: 1,
  },
  link: {
    ...typography.caption,
    fontSize: 13,
    fontWeight: '600',
  },
  navRow: {
    marginTop: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  navBtn: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    minWidth: 92,
  },
  navText: {
    ...typography.body,
    fontWeight: '600',
  },
  counter: {
    ...typography.caption,
    fontSize: 13,
  },
});
