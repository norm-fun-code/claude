import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import type { BriefSignal } from '../hooks/useBriefing';
import { BRIEFING_CONTEXT_URL, authHeaders, fetchWithTimeout } from '../config';

interface Props {
  signals: BriefSignal[];
}

const STORAGE_KEY = 'briefSignalsAnswered';
const TTL_MS = 24 * 60 * 60 * 1000;

type StoredEntry = { key: string; ts: number };

function persistDismiss(key: string) {
  AsyncStorage.getItem(STORAGE_KEY).then((val) => {
    const existing: StoredEntry[] = val ? JSON.parse(val) : [];
    const cutoff = Date.now() - TTL_MS;
    const fresh = existing.filter((s) => s.ts > cutoff && s.key !== key);
    fresh.push({ key, ts: Date.now() });
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(fresh)).catch(() => {});
  }).catch(() => {});
}

// One question at a time — show the first unanswered signal, answer it, then
// the card slides to the next (or disappears). Answers POST as annotations so
// they flow automatically into the next briefing build's annotationsContext.
// Answered/skipped keys are persisted for 24h so the card doesn't reappear
// on pull-to-refresh or app restart while the signal is still firing.
export function BriefSignalsCard({ signals }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((val) => {
      if (!val) return;
      const stored: StoredEntry[] = JSON.parse(val);
      const cutoff = Date.now() - TTL_MS;
      const fresh = stored.filter((s) => s.ts > cutoff);
      if (fresh.length > 0) setAnswered(new Set(fresh.map((s) => s.key)));
      if (fresh.length < stored.length) {
        AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(fresh)).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  const pending = signals.filter((s) => !answered.has(s.key));
  if (pending.length === 0) return null;

  const current = pending[0];

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      const res = await fetchWithTimeout(BRIEFING_CONTEXT_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ question: current.question, answer: trimmed, signalKey: current.key }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      setAnswered((prev) => new Set([...prev, current.key]));
      persistDismiss(current.key);
      setText('');
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  function skip() {
    setAnswered((prev) => new Set([...prev, current.key]));
    persistDismiss(current.key);
    setText('');
    setFailed(false);
  }

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <Text style={[styles.kicker, { color: c.subtext }]}>CHIEF OF STAFF</Text>
      <Text style={[styles.question, { color: c.text }]}>{current.question}</Text>

      <View style={styles.inputRow}>
        <TextInput
          style={[styles.input, { color: c.text, borderColor: c.border }]}
          placeholder="Your answer…"
          placeholderTextColor={c.subtext}
          value={text}
          onChangeText={setText}
          returnKeyType="send"
          onSubmitEditing={submit}
          multiline={false}
          autoCorrect
          spellCheck
        />
        <TouchableOpacity
          onPress={submit}
          disabled={!text.trim() || saving}
          style={[styles.sendBtn, { backgroundColor: c.accent, opacity: text.trim() && !saving ? 1 : 0.4 }]}
        >
          <Text style={styles.sendBtnText}>Send</Text>
        </TouchableOpacity>
      </View>

      {failed && (
        <Text style={styles.failed}>Couldn't save — check your connection and try again.</Text>
      )}

      <TouchableOpacity onPress={skip} style={styles.skipRow}>
        <Text style={[styles.skipText, { color: c.subtext }]}>Skip</Text>
      </TouchableOpacity>
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
  question: {
    ...typography.body,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '600',
    marginBottom: spacing.md,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    ...typography.body,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
  },
  sendBtn: {
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
  },
  sendBtnText: {
    ...typography.body,
    fontWeight: '700',
    color: '#fff',
    fontSize: 14,
  },
  failed: {
    ...typography.caption,
    color: '#C0392B',
    marginTop: spacing.sm,
  },
  skipRow: {
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
  },
  skipText: {
    ...typography.caption,
    fontSize: 13,
  },
});
