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
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { HIGHLIGHTS_URL, authHeaders, fetchWithTimeout } from '../config';

interface Highlight {
  id: string;
  text: string;
  title: string | null;
  author: string | null;
  url: string | null;
  favorite: boolean;
}

// "From Your Library" — Readwise highlights for the Wisdom tab. DAY-LOCKED: the
// server picks the day's set on the first request and returns the same set all
// day (across devices and pull-to-refresh), like the Notion page and daily
// quote. Tap "Next" to flip through them; "New set ↻" (or paging past the end)
// asks the server for a fresh set via ?refresh=1.
function HighlightsCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Fetch the day's set. `refresh` forces a NEW set (explicit user action);
  // otherwise the server returns today's locked set.
  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(false);
    try {
      const url = `${HIGHLIGHTS_URL}?limit=5${refresh ? '&refresh=1' : ''}`;
      const res = await fetchWithTimeout(url, { headers: authHeaders() });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const json = await res.json();
      setHighlights(json.highlights ?? []);
      setIdx(0);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(false); // today's locked set
  }, [load]);

  const next = () => {
    if (idx < highlights.length - 1) setIdx(idx + 1);
    else load(true); // reached the end — ask for a fresh set
  };

  const back = () => {
    if (idx > 0) setIdx(idx - 1);
  };

  const current = highlights[idx];

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
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

const HighlightsCardMemo = React.memo(HighlightsCard);
export { HighlightsCardMemo as HighlightsCard };
