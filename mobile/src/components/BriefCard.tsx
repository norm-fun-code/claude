import React, { useState } from 'react';
import { View, Text, StyleSheet, useColorScheme, TextInput, TouchableOpacity } from 'react-native';
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
    <View style={[styles.card, { backgroundColor: c.hero }, shadow(isDark)]}>
      <Text style={[styles.kicker, { color: c.accent }]}>CHIEF OF STAFF BRIEF</Text>

      {brief ? (
        <>
          <Text style={styles.synthesis}>{brief.synthesis}</Text>
          <View style={styles.separator} />
          {BLOCKS.map(({ key, label }) => (
            <View key={key} style={styles.block}>
              <Text style={styles.blockLabel}>{label}</Text>
              <Text style={styles.blockText}>{brief[key]}</Text>
            </View>
          ))}
        </>
      ) : (
        <Text style={styles.synthesis}>{fallback}</Text>
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
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  kicker: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: spacing.sm,
  },
  synthesis: {
    ...typography.body,
    color: '#fff',
    lineHeight: 23,
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
    letterSpacing: 0.8,
    color: 'rgba(99,91,255,0.85)',
    marginBottom: 3,
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
