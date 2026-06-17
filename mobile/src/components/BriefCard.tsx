import React, { useState } from 'react';
import { View, Text, StyleSheet, useColorScheme, TextInput, TouchableOpacity } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import type { ChiefBrief } from '../hooks/useBriefing';
import { BRIEFING_CONTEXT_URL, authHeaders, fetchWithTimeout } from '../config';

interface Props {
  brief: ChiefBrief | null | undefined;
  /** Fallback single-paragraph focus, shown when the structured brief isn't ready yet. */
  fallback?: string;
}

const BLOCKS: { key: keyof Omit<ChiefBrief, 'synthesis'>; label: string }[] = [
  { key: 'action', label: 'THE ACTION' },
  { key: 'risk', label: 'THE RISK' },
  { key: 'move', label: 'THE MOVE' },
];

// The Chief of Staff closes every brief on these — a fixed daily anchor.
const AFFIRMATIONS = [
  'I show up with joy, presence, and courage!',
  'Everything always works out!',
  'We will always live and love in abundance!',
];

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
    <Animated.View entering={FadeIn.duration(400)} style={[styles.card, shadow(isDark)]}>
      <LinearGradient
        colors={['#272730', '#1C1C1E']}
        start={{ x: 0, y: 0 }}
        end={{ x: 0.6, y: 1 }}
        style={styles.gradient}
      />
      <Text style={[styles.kicker, { color: '#A89CFF' }]}>CHIEF OF STAFF BRIEF</Text>

      {brief ? (
        <>
          <Animated.Text entering={FadeInDown.delay(80).duration(300)} style={styles.synthesis}>{brief.synthesis}</Animated.Text>
          <View style={styles.separator} />
          {BLOCKS.map(({ key, label }, idx) => (
            <Animated.View key={key} entering={FadeInDown.delay(160 + idx * 60).duration(280)} style={styles.block}>
              <Text style={styles.blockLabel}>{label}</Text>
              <Text style={styles.blockText}>{brief[key]}</Text>
            </Animated.View>
          ))}
        </>
      ) : (
        <Animated.Text entering={FadeInDown.delay(80).duration(300)} style={styles.synthesis}>{fallback}</Animated.Text>
      )}

      {/* Affirmations — the Chief of Staff closes every brief on an up note. */}
      <View style={styles.separator} />
      <Text style={styles.blockLabel}>AFFIRMATIONS</Text>
      {AFFIRMATIONS.map((text, i) => (
        <View key={i} style={styles.affRow}>
          <Text style={styles.affBullet}>✦</Text>
          <Text style={styles.affText}>{text}</Text>
        </View>
      ))}

      {/* Context window — freeform note that feeds into the next briefing build. */}
      <View style={styles.separator} />
      <Text style={styles.blockLabel}>ADD CONTEXT FOR NEXT BRIEF</Text>
      <View style={styles.contextRow}>
        <TextInput
          style={styles.contextInput}
          placeholder="Anything the Chief of Staff should know…"
          placeholderTextColor="rgba(255,255,255,0.45)"
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
    </Animated.View>
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
    borderRadius: radius.xl,
  },
  kicker: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
    marginBottom: spacing.sm,
  },
  synthesis: {
    fontSize: 16,
    fontWeight: '400',
    color: '#fff',
    lineHeight: 25,
    letterSpacing: -0.1,
    marginBottom: spacing.md,
  },
  separator: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.2)',
    marginBottom: spacing.md,
  },
  block: {
    marginBottom: spacing.sm + 2,
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
    lineHeight: 21,
  },
  affRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginTop: 5,
  },
  affBullet: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    lineHeight: 21,
  },
  affText: {
    ...typography.body,
    color: '#fff',
    fontSize: 14,
    lineHeight: 21,
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
    borderColor: 'rgba(255,255,255,0.3)',
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  contextBtn: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
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
    color: 'rgba(255,255,255,0.7)',
    marginTop: spacing.xs,
    fontSize: 12,
  },
});
