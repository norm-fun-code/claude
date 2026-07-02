import React, { useState } from 'react';
import { View, Text, StyleSheet, useColorScheme, TextInput, TouchableOpacity, Pressable, LayoutAnimation } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, radius, typography, shadow, glow, accentGradient, withAlpha, FONTS } from '../theme';
import { AnimatedEntry } from './AnimatedEntry';
import type { ChiefBrief } from '../hooks/useBriefing';
import { BRIEFING_CONTEXT_URL, authHeaders, fetchWithTimeout } from '../config';

interface Props {
  brief: ChiefBrief | null | undefined;
  fallback?: string;
}

// Each block gets a mini emoji tile (same elevated-tile language as
// SectionHeader) and its own tint so the three beats read as distinct at a
// glance even before any text is parsed.
const BLOCKS: { key: keyof Omit<ChiefBrief, 'synthesis'>; label: string; emoji: string; tint: string }[] = [
  { key: 'action', label: 'THE ACTION', emoji: '⚡️', tint: '#A89CFF' },
  { key: 'risk', label: 'THE RISK', emoji: '⚠️', tint: '#FFC44D' },
  { key: 'move', label: 'THE MOVE', emoji: '📈', tint: '#5AE89A' },
];

const AFFIRMATIONS = [
  'I show up with joy, presence, and courage!',
  'Everything always works out!',
  'We will always live and love in abundance!',
];

// Editorial number highlighting: the synthesis is a headline, and the numbers
// are its payload — set them in the accent so the eye catches "64", "29%",
// "$7,497" before reading a word. Word-level match (not a global regex) so
// "30-minute" stays plain while "10,314", "4.6/5", "38.4ms" light up.
const NUM_CORE = /^([("']*)(\$?\d[\d,.]*(?:%|ms|bpm|h|k|x)?(?:\/\d+)?)([)"',.;:!?]*)$/;

function HighlightedSynthesis({ text }: { text: string }) {
  const words = text.split(' ');
  return (
    <Text style={styles.synthesis}>
      {words.map((w, i) => {
        const m = w.match(NUM_CORE);
        const space = i < words.length - 1 ? ' ' : '';
        if (!m) return w + space;
        return (
          <React.Fragment key={i}>
            {m[1]}
            <Text style={styles.synthesisNum}>{m[2]}</Text>
            {m[3] + space}
          </React.Fragment>
        );
      })}
    </Text>
  );
}

// One compact, expandable beat row. Collapsed it's a two-line scannable
// summary; tapping unfolds the full text in place. LayoutAnimation keeps the
// unfold soft instead of a jump cut.
function BeatRow({ label, emoji, tint, text }: { label: string; emoji: string; tint: string; text: string }) {
  const [open, setOpen] = useState(false);

  const toggle = () => {
    Haptics.selectionAsync();
    LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'));
    setOpen((v) => !v);
  };

  return (
    <Pressable onPress={toggle} style={styles.beat}>
      <View style={[styles.beatTile, { backgroundColor: withAlpha(tint, 0.16), borderColor: withAlpha(tint, 0.28) }]}>
        <Text style={styles.beatEmoji}>{emoji}</Text>
      </View>
      <View style={styles.beatBody}>
        <View style={styles.beatHead}>
          <Text style={[styles.blockLabel, { color: tint, marginBottom: 0 }]}>{label}</Text>
          <Text style={[styles.beatChevron, open && styles.beatChevronOpen]}>›</Text>
        </View>
        <Text style={styles.blockText} numberOfLines={open ? undefined : 2}>
          {text}
        </Text>
      </View>
    </Pressable>
  );
}

export function BriefCard({ brief, fallback }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [note, setNote] = useState('');
  const [noteSaved, setNoteSaved] = useState(false);
  const [noteFailed, setNoteFailed] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);

  async function saveNote() {
    const trimmed = note.trim();
    if (!trimmed || noteSaving) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setNoteSaving(true);
    setNoteFailed(false);
    try {
      const res = await fetchWithTimeout(BRIEFING_CONTEXT_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ answer: trimmed, signalKey: 'manual_context' }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      setNote('');
      setNoteSaved(true);
      setTimeout(() => setNoteSaved(false), 3000);
    } catch {
      setNoteFailed(true);
    } finally {
      setNoteSaving(false);
    }
  }

  if (!brief && !fallback) return null;

  return (
    <View style={[styles.card, glow('#5A52F0', 0.22, 26)]}>
      <LinearGradient
        colors={['#2A2A36', '#1A1A1F']}
        start={{ x: 0, y: 0 }}
        end={{ x: 0.7, y: 1 }}
        style={styles.gradient}
      />
      {/* signature accent bar */}
      <LinearGradient colors={accentGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.accentBar} />
      <Text style={styles.kicker}>CHIEF OF STAFF BRIEF</Text>

      {brief ? (
        <>
          <AnimatedEntry delay={60} distance={10}>
            <HighlightedSynthesis text={brief.synthesis} />
          </AnimatedEntry>
          <View style={styles.separator} />
          {BLOCKS.map(({ key, label, emoji, tint }, idx) => (
            <AnimatedEntry key={key} delay={130 + idx * 55} distance={8}>
              <BeatRow label={label} emoji={emoji} tint={tint} text={brief[key]} />
            </AnimatedEntry>
          ))}
        </>
      ) : (
        <AnimatedEntry delay={60} distance={10}>
          <Text style={styles.synthesis}>{fallback}</Text>
        </AnimatedEntry>
      )}

      <View style={styles.separator} />
      <Text style={styles.blockLabel}>AFFIRMATIONS</Text>
      {AFFIRMATIONS.map((text, i) => (
        <View key={i} style={styles.affRow}>
          <Text style={styles.affBullet}>✦</Text>
          <Text style={styles.affText}>{text}</Text>
        </View>
      ))}

      <View style={styles.separator} />
      <Text style={styles.blockLabel}>ADD CONTEXT FOR NEXT BRIEF</Text>
      <View style={styles.contextRow}>
        <TextInput
          style={styles.contextInput}
          placeholder="Anything the Chief of Staff should know…"
          placeholderTextColor="rgba(255,255,255,0.4)"
          value={note}
          onChangeText={setNote}
          returnKeyType="send"
          onSubmitEditing={saveNote}
          multiline={false}
        />
        <TouchableOpacity
          onPress={saveNote}
          disabled={!note.trim() || noteSaving}
          style={[styles.contextBtn, { opacity: note.trim() && !noteSaving ? 1 : 0.4 }]}
        >
          <Text style={styles.contextBtnText}>{noteSaved ? '✓' : '→'}</Text>
        </TouchableOpacity>
      </View>
      {noteFailed && <Text style={styles.contextFailed}>Couldn't save — try again.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    padding: spacing.lg,
    marginBottom: spacing.md,
    overflow: 'hidden',
    backgroundColor: '#1C1C1E',
  },
  gradient: {
    ...StyleSheet.absoluteFillObject,
  },
  accentBar: {
    width: 44,
    height: 3,
    borderRadius: 2,
    marginBottom: spacing.sm,
  },
  kicker: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
    color: '#A89CFF',
    marginBottom: spacing.sm,
  },
  // The synthesis IS the headline — editorial display type, not body copy.
  synthesis: {
    fontFamily: FONTS.display,
    fontSize: 21,
    fontWeight: '700',
    color: '#fff',
    lineHeight: 30,
    letterSpacing: -0.4,
    marginBottom: spacing.md,
  },
  synthesisNum: {
    color: '#A89CFF',
  },
  separator: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.12)',
    marginBottom: spacing.md,
  },
  beat: {
    flexDirection: 'row',
    gap: spacing.sm + 2,
    marginBottom: spacing.md,
    alignItems: 'flex-start',
  },
  beatTile: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  beatEmoji: {
    fontSize: 12,
    lineHeight: 16,
  },
  beatBody: {
    flex: 1,
  },
  beatHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 3,
  },
  beatChevron: {
    color: 'rgba(255,255,255,0.35)',
    fontSize: 15,
    fontWeight: '700',
    transform: [{ rotate: '90deg' }],
  },
  beatChevronOpen: {
    transform: [{ rotate: '-90deg' }],
  },
  blockLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.0,
    color: '#A89CFF',
    marginBottom: 4,
  },
  blockText: {
    ...typography.body,
    color: '#fff',
    fontSize: 14,
    lineHeight: 22,
  },
  affRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginTop: 5,
  },
  affBullet: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    lineHeight: 22,
  },
  affText: {
    ...typography.body,
    color: 'rgba(255,255,255,0.85)',
    fontSize: 14,
    lineHeight: 22,
    fontStyle: 'italic',
    flex: 1,
  },
  contextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  contextInput: {
    flex: 1,
    ...typography.body,
    fontSize: 13,
    color: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  contextBtn: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  contextBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  contextFailed: {
    ...typography.caption,
    color: 'rgba(255,255,255,0.6)',
    marginTop: spacing.xs,
    fontSize: 12,
  },
});
