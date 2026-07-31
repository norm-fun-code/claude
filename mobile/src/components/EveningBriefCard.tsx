import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { spacing, radius, typography, glow, bandGradient, withAlpha } from '../theme';
import type { EveningBrief, EveningTone } from '../hooks/useEveningBrief';
import { EVENING_BRIEF_AUDIO_URL } from '../config';
import { voiceAvailable } from '../lib/voice';
import { useBriefAudio } from '../hooks/useBriefAudio';
import { isNarrationBusy, narrationButtonLabel } from '../lib/narrationStatus';

interface Props {
  brief: EveningBrief | null | undefined;
}

// Autonomic tone → the same band language the recovery orb uses, so green/amber/red
// reads consistently across the app. Settled=green, mild=amber, elevated=red.
const TONE_BAND: Record<EveningTone, keyof typeof bandGradient> = {
  settled: 'green',
  mild: 'yellow',
  elevated: 'red',
  unknown: 'neutral',
};

// Same tinted mini-tile beat language as the morning BriefCard, so the two
// hero briefs speak one design system on the same Today screen. TODAY/PLAN
// are the "how did today land" half of the brief; TONIGHT (tomorrow's
// bedtime lever + any genuinely night-compatible habit) and LET GO (habits
// deliberately released, never framed as missed quick wins) render as their
// own sections below, not as more rows in this list — see the render body.
const BLOCKS: { key: keyof Pick<EveningBrief, 'today' | 'plan'>; label: string; emoji: string; tint: string }[] = [
  { key: 'today', label: 'TODAY', emoji: '👣', tint: '#3B9EFF' },
  // Day-close ledger — this morning's plan graded against what actually happened.
  { key: 'plan', label: 'PLAN VS ACTUAL', emoji: '🎯', tint: '#5AE89A' },
];

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipValue}>{value}</Text>
      <Text style={styles.chipLabel}>{label}</Text>
    </View>
  );
}

function EveningBriefCard({ brief }: Props) {
  // Uses useBriefAudio's shared default timeout/poll-retry policy — see that
  // hook's doc comment.
  const { state: audioState, toggle: toggleListen } = useBriefAudio(EVENING_BRIEF_AUDIO_URL);

  if (!brief || !brief.headline) return null;
  const band = TONE_BAND[brief.tone] || 'neutral';
  const [g1, g2] = bandGradient[band];
  const s = brief.signals || ({} as EveningBrief['signals']);

  // Steps are NOT chipped here — the "today" block below already states the
  // exact count and how it compares to baseline in prose; repeating it as a
  // chip is the steps-shown-twice bug this redesign fixes. Chips stay to the
  // body-tone signals (HRV/RHR) the prose reads FROM but doesn't restate as
  // raw numbers.
  const chips: { label: string; value: string }[] = [];
  if (s.hrv != null) chips.push({ label: s.hrvBaseline != null ? `HRV · norm ${Math.round(s.hrvBaseline)}` : 'HRV', value: `${Math.round(s.hrv)}ms` });
  if (s.rhr != null) chips.push({ label: s.rhrBaseline != null ? `RHR · norm ${Math.round(s.rhrBaseline)}` : 'RHR', value: `${Math.round(s.rhr)}` });

  const tonightText = (brief.tomorrow || '').trim();
  const stillWorthText = (brief.habits || '').trim();
  const letGoText = (brief.letGo || '').trim();
  const hasTonight = !!(tonightText || stillWorthText);

  return (
    <View style={[styles.card, glow(g1, 0.2, 24)]}>
      <LinearGradient colors={['#23232E', '#161619']} start={{ x: 0, y: 0 }} end={{ x: 0.7, y: 1 }} style={styles.gradient} />
      <LinearGradient colors={[g1, g2]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.accentBar} />

      <View style={styles.kickerRow}>
        <Text style={styles.kicker}>EVENING · WIND DOWN</Text>
        {voiceAvailable && (
          <Pressable
            onPress={toggleListen}
            hitSlop={8}
            style={styles.listenBtn}
            accessibilityRole="button"
            accessibilityLabel={audioState === 'playing' ? 'Stop narration' : 'Listen to tonight\'s wind-down brief'}
            accessibilityState={{ busy: isNarrationBusy(audioState) }}
            >
              <Text style={styles.listenText}>{narrationButtonLabel(audioState)}</Text>
            </Pressable>
        )}
      </View>

      {/* No internal entrance animation: this card loads async and inserts at the
          top of the feed, so per-line springs cascading WHILE the layout shifts
          read as a shake/glitch. It renders statically and fades in as one unit
          (the outer wrapper in App.tsx handles a single opacity fade). */}
      <Text style={styles.headline}>{brief.headline}</Text>
      <Text style={styles.readiness}>{brief.readiness}</Text>

      {chips.length > 0 && (
        <View style={styles.chipRow}>
          {chips.map((ch) => (
            <Chip key={ch.label} label={ch.label} value={ch.value} />
          ))}
        </View>
      )}

      <View style={styles.separator} />

      {BLOCKS.filter(({ key }) => (brief[key] || '').trim()).map(({ key, label, emoji, tint }) => (
        <View key={key} style={styles.beat}>
          <View style={[styles.beatTile, { backgroundColor: withAlpha(tint, 0.16), borderColor: withAlpha(tint, 0.28) }]}>
            <Text style={styles.beatEmoji}>{emoji}</Text>
          </View>
          <View style={styles.beatBody}>
            <Text style={[styles.blockLabel, { color: tint }]}>{label}</Text>
            <Text style={styles.blockText}>{brief[key]}</Text>
          </View>
        </View>
      ))}

      {/* TONIGHT — the bedtime lever (brief.tomorrow) plus any genuinely
          night-compatible still-open habit (brief.habits — evening-readiness.js
          already filtered this to calm/restorative ones only), merged into one
          "what's worth doing before bed" beat rather than two separate rows. */}
      {hasTonight ? (
        <View style={styles.beat}>
          <View style={[styles.beatTile, { backgroundColor: withAlpha('#A78BFA', 0.16), borderColor: withAlpha('#A78BFA', 0.28) }]}>
            <Text style={styles.beatEmoji}>🌙</Text>
          </View>
          <View style={styles.beatBody}>
            <Text style={[styles.blockLabel, { color: '#A78BFA' }]}>TONIGHT</Text>
            {!!tonightText && <Text style={styles.blockText}>{tonightText}</Text>}
            {!!stillWorthText && <Text style={[styles.blockText, tonightText ? styles.blockTextStacked : null]}>{stillWorthText}</Text>}
          </View>
        </View>
      ) : null}

      {/* LET GO — habits that missed their window or would compete with winding
          down tonight, framed as a deliberate release rather than an unfinished
          "quick win" — calmer, muted styling on purpose (not another to-do). */}
      {!!letGoText && (
        <View style={styles.beat}>
          <View style={[styles.beatTile, { backgroundColor: withAlpha('#8FA98C', 0.14), borderColor: withAlpha('#8FA98C', 0.24) }]}>
            <Text style={styles.beatEmoji}>🍃</Text>
          </View>
          <View style={styles.beatBody}>
            <Text style={[styles.blockLabel, { color: '#8FA98C' }]}>LET GO</Text>
            <Text style={styles.blockText}>{letGoText}</Text>
          </View>
        </View>
      )}

      {/* Presence beat — the mindfulness counterpart to the body read. Set apart
          from the somatic blocks with its own quiet styling. Omitted entirely
          (not just hidden) when there's no genuine gratitude note to echo — see
          evening-brief.js's composeFallback/validate: an invented "name one
          thing you're grateful for" prompt is not rendered here on purpose. */}
      {(brief.reflection || '').trim() ? (
        <View style={styles.reflection}>
          <View style={styles.beat}>
            <View style={[styles.beatTile, { backgroundColor: withAlpha('#5AE89A', 0.14), borderColor: withAlpha('#5AE89A', 0.24) }]}>
              <Text style={styles.beatEmoji}>✨</Text>
            </View>
            <View style={styles.beatBody}>
              <Text style={[styles.blockLabel, { color: '#5AE89A' }]}>REFLECT</Text>
              <Text style={styles.reflectionText}>{brief.reflection}</Text>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    padding: spacing.lg,
    marginBottom: spacing.md,
    overflow: 'hidden',
    backgroundColor: '#1A1A1E',
  },
  gradient: { ...StyleSheet.absoluteFillObject },
  accentBar: { width: 44, height: 3, borderRadius: 2, marginBottom: spacing.sm },
  kickerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  kicker: { fontSize: 10, fontWeight: '700', letterSpacing: 1.4, color: 'rgba(255,255,255,0.55)' },
  listenBtn: {
    borderWidth: 1,
    borderColor: 'rgba(167,139,250,0.4)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 3,
    minWidth: 64,
    alignItems: 'center',
  },
  listenText: { color: '#A78BFA', fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  headline: { fontSize: 20, fontWeight: '700', color: '#fff', letterSpacing: -0.3, marginBottom: spacing.sm, lineHeight: 27 },
  readiness: { fontSize: 15, fontWeight: '400', color: 'rgba(255,255,255,0.92)', lineHeight: 24, marginBottom: spacing.md },
  chipRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md, flexWrap: 'wrap' },
  chip: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minWidth: 64,
  },
  chipValue: { ...typography.metricSmall, color: '#fff', fontSize: 18, letterSpacing: -0.4 },
  chipLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 10, fontWeight: '600', marginTop: 2, letterSpacing: 0.3 },
  separator: { height: 1, backgroundColor: 'rgba(255,255,255,0.12)', marginBottom: spacing.md },
  beat: { flexDirection: 'row', gap: spacing.sm + 2, marginBottom: spacing.md, alignItems: 'flex-start' },
  beatTile: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  beatEmoji: { fontSize: 12, lineHeight: 16 },
  beatBody: { flex: 1 },
  blockLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1.0, color: 'rgba(255,255,255,0.55)', marginBottom: 4 },
  blockText: { ...typography.body, color: '#fff', fontSize: 14, lineHeight: 22 },
  blockTextStacked: { marginTop: 4, color: 'rgba(255,255,255,0.72)' },
  reflection: {
    marginTop: spacing.xs,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.10)',
  },
  reflectionText: { ...typography.body, color: 'rgba(255,255,255,0.9)', fontSize: 14, lineHeight: 22, fontStyle: 'italic' },
});

const EveningBriefCardMemo = React.memo(EveningBriefCard);
export { EveningBriefCardMemo as EveningBriefCard };
