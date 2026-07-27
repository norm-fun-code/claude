import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, useColorScheme, Alert } from 'react-native';
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
  const [actionError, setActionError] = useState<string | null>(null);

  const act = useCallback(async (path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetchWithTimeout(`${BELIEFS_URL}/${belief.id}${path}`, {
        method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined,
      }, 10000);
      if (!res.ok) {
        setActionError(res.status === 404 ? 'This belief no longer exists.' : 'That action failed — please try again.');
        return;
      }
      onChanged();
    } catch {
      setActionError('Could not reach the server — please try again.');
    } finally {
      setBusy(false);
    }
  }, [belief.id, onChanged]);

  const confirmForget = useCallback(() => {
    Alert.alert(
      'Forget this belief?',
      'This is destructive: NormOS will stop surfacing it, and the same pattern can be relearned from scratch later. This cannot be undone from here.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Forget', style: 'destructive', onPress: () => act('', 'DELETE') },
      ],
    );
  }, [act]);

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
              <TouchableOpacity onPress={confirmForget} disabled={busy} hitSlop={6}>
                <Text style={[styles.actionText, { color: '#FF6B6B' }]}>Forget</Text>
              </TouchableOpacity>
            </View>
          )}
          {actionError ? <Text style={[styles.errorText, { color: '#FF6B6B' }]}>{actionError}</Text> : null}
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
  // Distinct from "no beliefs yet": a fetch/HTTP failure must never render as
  // the honest empty state — that would be a false empty state hiding a real
  // outage from the user.
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithTimeout(BELIEFS_URL, { headers: authHeaders() });
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      const json = await res.json();
      setBeliefs(json.beliefs ?? []);
      setLoadError(false);
    } catch {
      setLoadError(true);
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
      ) : loadError ? (
        <View>
          <Text style={[styles.errorText, { color: '#FF6B6B' }]}>Couldn't load beliefs — check your connection.</Text>
          <TouchableOpacity onPress={load} hitSlop={6}>
            <Text style={[styles.actionText, { color: c.accent, marginTop: spacing.xs }]}>Retry</Text>
          </TouchableOpacity>
        </View>
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
  errorText: { ...typography.caption, fontSize: 13, marginTop: spacing.xs },
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
