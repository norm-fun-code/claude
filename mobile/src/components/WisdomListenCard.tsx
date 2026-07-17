import React from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, useColorScheme } from 'react-native';
import { getColors, spacing, radius, shadow, withAlpha } from '../theme';
import { SectionHeader } from './SectionHeader';
import { WISDOM_AUDIO_URL } from '../config';
import { voiceAvailable } from '../lib/voice';
import { useBriefAudio } from '../hooks/useBriefAudio';

interface Props {
  // Whether today's Wisdom actually has anything to narrate — mirrors the
  // exact same fields backend/src/services/voice.js's
  // composeWisdomNarrationScript reads (quote+insight, notion passage+
  // insight, relevant highlight), so this can never show "Listen" for
  // content the server would just 404 on with nothing_to_narrate.
  hasContent: boolean;
  // Binds "Listen" to the EXACT build on screen (BriefingData.snapshotId) —
  // audit fix, item 4: never lets a stale mobile cache narrate a different
  // build than what's actually displayed.
  snapshotId?: string | null;
}

const GOLD = '#FF9F0A';

/** Compact, prominent Listen entry point near the top of the Wisdom tab —
 *  same shared playback state machine (idle/loading/playing/error, tap to
 *  stop, auto-retry-affordance on error, cross-card "only one narration at
 *  once") as Chief Brief and Evening Brief's own Listen buttons. Hides
 *  entirely when there's nothing narratable yet, or when voice playback
 *  isn't available on this build. */
function WisdomListenCard({ hasContent, snapshotId }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const { state: audioState, toggle: toggleListen } = useBriefAudio(WISDOM_AUDIO_URL, 60000, snapshotId);

  if (!voiceAvailable || !hasContent) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <View style={styles.row}>
        <SectionHeader emoji="🎧" title="Listen" tint="gold" />
        <Pressable
          onPress={toggleListen}
          hitSlop={8}
          style={[styles.listenBtn, { borderColor: withAlpha(GOLD, 0.4) }]}
          accessibilityRole="button"
          accessibilityLabel={audioState === 'playing' ? 'Stop narration' : "Listen to today's wisdom"}
          accessibilityState={{ busy: audioState === 'loading', disabled: audioState === 'loading' }}
        >
          {audioState === 'loading' ? (
            <ActivityIndicator size="small" color={GOLD} />
          ) : (
            <Text style={[styles.listenText, { color: GOLD }]}>
              {audioState === 'playing' ? '◼ Stop' : audioState === 'error' ? 'Unavailable' : '▶ Listen'}
            </Text>
          )}
        </Pressable>
      </View>
      <Text style={[styles.subtext, { color: c.subtext }]}>
        Today's quote, reading, and library pick — read aloud in under two minutes.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  listenBtn: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 3,
    minWidth: 64,
    alignItems: 'center',
  },
  listenText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  subtext: { fontSize: 12, lineHeight: 17, marginTop: 2 },
});

const WisdomListenCardMemo = React.memo(WisdomListenCard);
export { WisdomListenCardMemo as WisdomListenCard };
