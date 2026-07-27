import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, useColorScheme } from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { BELIEFS_URL, authHeaders, fetchWithTimeout } from '../config';

interface Belief {
  id: number;
  kind: string;
  statement: string;
  status: 'confirmed' | 'supported' | 'hypothesis' | 'retired';
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
}

const STATUS_LABEL: Record<Belief['status'], string> = {
  confirmed: 'Confirmed',
  supported: 'Supported',
  hypothesis: 'Hypothesis',
  retired: 'Retired',
};
const STATUS_COLOR: Record<Belief['status'], string> = {
  confirmed: '#1D9E75',
  supported: '#3B9EFF',
  hypothesis: '#8E8E93',
  retired: '#8E8E93',
};

function BeliefRow({ belief, onChanged, c, isDark }: {
  belief: Belief;
  onChanged: () => void;
  c: ReturnType<typeof getColors>;
  isDark: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(belief.statement);
  const [busy, setBusy] = useState(false);

  const act = useCallback(async (path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) => {
    setBusy(true);
    try {
      await fetchWithTimeout(`${BELIEFS_URL}/${belief.id}${path}`, {
        method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined,
      }, 10000);
      onChanged();
    } catch {
      // Best-effort — a failed action just leaves the belief as-is; the user
      // can retry, and nothing here silently corrupts the durable record.
    } finally {
      setBusy(false);
    }
  }, [belief.id, onChanged]);

  return (
    <View style={[styles.row, { borderBottomColor: c.border }]}>
      <View style={styles.rowHead}>
        <View style={[styles.statusPill, { backgroundColor: STATUS_COLOR[belief.status] + '22' }]}>
          <Text style={[styles.statusText, { color: STATUS_COLOR[belief.status] }]}>{STATUS_LABEL[belief.status]}</Text>
        </View>
        {belief.confidence != null ? (
          <Text style={[styles.confidence, { color: c.subtext }]}>{Math.round(belief.confidence * 100)}% confidence</Text>
        ) : null}
      </View>
      {editing ? (
        <View style={styles.editWrap}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: isDark ? '#1C1C1A' : '#F9F8F6' }]}
            multiline
            autoCorrect
            spellCheck
          />
          <View style={styles.actionsRow}>
            <TouchableOpacity onPress={() => { setEditing(false); setDraft(belief.statement); }} hitSlop={6}>
              <Text style={[styles.actionText, { color: c.subtext }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { act('', 'PATCH', { statement: draft }); setEditing(false); }} hitSlop={6}>
              <Text style={[styles.actionText, { color: c.accent }]}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <>
          <Text style={[styles.statement, { color: c.text }]}>{belief.statement}</Text>
          {belief.status !== 'retired' && (
            <View style={styles.actionsRow}>
              {belief.status !== 'confirmed' && (
                <TouchableOpacity onPress={() => act('/confirm', 'POST')} disabled={busy} hitSlop={6}>
                  <Text style={[styles.actionText, { color: '#1D9E75' }]}>Confirm</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => setEditing(true)} disabled={busy} hitSlop={6}>
                <Text style={[styles.actionText, { color: c.accent }]}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => act('/retire', 'POST')} disabled={busy} hitSlop={6}>
                <Text style={[styles.actionText, { color: c.subtext }]}>Retire</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => act('', 'DELETE')} disabled={busy} hitSlop={6}>
                <Text style={[styles.actionText, { color: '#FF6B6B' }]}>Forget</Text>
              </TouchableOpacity>
            </View>
          )}
        </>
      )}
    </View>
  );
}

/**
 * Health tab redesign (audit rec #4), item 5 — "What NormOS currently
 * believes" replaces the raw generated NormOS Profile prose as the primary
 * surface for this durable knowledge. Reads/writes the existing beliefs
 * store (backend/src/store/beliefs.js) through the new thin routes/beliefs.js
 * — not a new learning authority, just a management UI over what
 * intelligence/beliefs.js already promotes nightly.
 */
export function BeliefsCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [beliefs, setBeliefs] = useState<Belief[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(BELIEFS_URL, { headers: authHeaders() });
      if (res.ok) {
        const json = await res.json();
        setBeliefs(json.beliefs ?? []);
      }
    } catch {
      // stay with whatever was last loaded
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const active = beliefs.filter((b) => b.status !== 'retired');

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="🧠" title="What NormOS currently believes" tint="blue" />
      {loading ? (
        <ActivityIndicator color={c.accent} style={{ marginVertical: spacing.md }} />
      ) : active.length === 0 ? (
        <Text style={[styles.empty, { color: c.subtext }]}>Nothing learned yet — this fills in as patterns are confirmed.</Text>
      ) : (
        active.map((b) => <BeliefRow key={b.id} belief={b} onChanged={load} c={c} isDark={isDark} />)
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  empty: { ...typography.caption, fontSize: 13, fontStyle: 'italic', marginTop: spacing.sm },
  row: { paddingVertical: spacing.sm, borderBottomWidth: 1, gap: 4 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusPill: { borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 2 },
  statusText: { fontSize: 11, fontWeight: '700' },
  confidence: { fontSize: 11 },
  statement: { ...typography.body, fontSize: 14, lineHeight: 20 },
  actionsRow: { flexDirection: 'row', gap: spacing.md, marginTop: 4 },
  actionText: { fontSize: 13, fontWeight: '600' },
  editWrap: { gap: spacing.xs },
  input: { borderWidth: 1, borderRadius: radius.sm, padding: spacing.sm, fontSize: 14, minHeight: 60, textAlignVertical: 'top' },
});
