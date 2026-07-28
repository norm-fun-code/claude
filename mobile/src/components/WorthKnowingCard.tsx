import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Pressable, TextInput, ActivityIndicator, Modal, useColorScheme, SafeAreaView, ScrollView } from 'react-native';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import type { Insight } from '../hooks/useBriefing';
import { selectWorthKnowing } from '../lib/healthWorthKnowing';
import { INSIGHT_DISMISS_URL, VOICE_TRANSCRIBE_URL, authHeaders, fetchWithTimeout } from '../config';
import { useAnomalyContext } from '../hooks/useAnomalyContext';
import { voiceAvailable, ensureMicPermission, startRecording, stopRecording } from '../lib/voice';

interface Props {
  insights: Insight[];
}

const EVIDENCE_TIER_LABEL: Record<string, string> = {
  anomaly: 'Deviation from your baseline',
  strain: 'Multi-signal pattern',
  correlation: 'Confirmed pattern',
  sleep_impact: 'Confirmed pattern',
  activity_impact: 'Confirmed pattern',
  daytime_cardio: 'Confirmed pattern',
  cross_context: 'Cross-domain pattern',
  training_load: 'Training trend',
  habit_consistency: 'Streak milestone',
  fitness: 'Fitness trend',
  sleep_debt: 'Data quality',
  sleep_surplus: 'Data quality',
  sleep_consistency: 'Consistency trend',
  sleep_regularity: 'Consistency trend',
};

function sampleWindowFrom(evidence: Record<string, unknown> | undefined): string | null {
  if (!evidence) return null;
  const n = evidence.n;
  const asOf = evidence.asOf;
  const parts: string[] = [];
  if (typeof n === 'number') parts.push(`n=${n}`);
  if (typeof asOf === 'string') parts.push(`as of ${new Date(asOf).toLocaleDateString()}`);
  return parts.length ? parts.join(' · ') : null;
}

// Parsed as noon UTC so the label reflects the calendar date the anomaly's
// own local_observation_date names, never shifted a day by the device's
// own timezone (same "render date-only values in UTC" convention as the
// backend's util/date.js formatDate).
function formatObservationDate(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/**
 * "What explains this?" — optional, opt-in context loop for anomaly cards
 * only (insight.evidence?.kind === 'anomaly'). Never opens automatically;
 * only appears once the user has already chosen to open this detail view.
 * Generic across every metric/domain — nothing here special-cases a
 * particular metric or phrase.
 */
function AnomalyContextPrompt({ insight }: { insight: Insight }) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const { card, ensure, answer, nothingUnusual, skip, forget } = useAnomalyContext();
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'thinking'>('idle');
  const [saving, setSaving] = useState(false);
  const [errored, setErrored] = useState(false);

  const evidence = insight.evidence;
  const anomalyKey = typeof evidence?.anomalyKey === 'string' ? evidence.anomalyKey : null;

  useEffect(() => {
    if (evidence?.kind !== 'anomaly' || !anomalyKey) return;
    ensure(insight.type, insight.domains, evidence);
    // Fire once per mounted detail view — this insight/evidence is fixed
    // for the lifetime of the modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anomalyKey]);

  if (evidence?.kind !== 'anomaly' || !anomalyKey || !card) return null;

  async function submit(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    setSaving(true);
    setErrored(false);
    const ok = await answer(anomalyKey!, trimmed);
    setSaving(false);
    if (ok) { setEditing(false); setText(''); } else { setErrored(true); }
  }

  async function voicePressIn() {
    if (voiceState !== 'idle') return;
    if (!(await ensureMicPermission())) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await startRecording();
      setVoiceState('recording');
    } catch {
      setVoiceState('idle');
    }
  }

  async function voicePressOut() {
    if (voiceState !== 'recording') return;
    setVoiceState('thinking');
    try {
      const rec = await stopRecording();
      if (!rec) return;
      const res = await fetchWithTimeout(VOICE_TRANSCRIBE_URL, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ audio: rec.base64, mime: rec.mime }),
      }, 30000);
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const data = await res.json();
      const transcribed = String(data?.text || '').trim();
      if (transcribed) setText((prev) => (prev ? `${prev} ${transcribed}` : transcribed));
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    } finally {
      setVoiceState('idle');
    }
  }

  if (card.status === 'answered' && !editing) {
    return (
      <View style={[detailStyles.contextBox, { borderColor: c.border }]}>
        <Text style={[detailStyles.contextAnswer, { color: c.text }]}>Your context: “{card.rawAnswer}”</Text>
        <View style={detailStyles.contextActionsRow}>
          <TouchableOpacity onPress={() => { setText(card.rawAnswer ?? ''); setEditing(true); }} hitSlop={8}>
            <Text style={[detailStyles.contextLink, { color: c.accent }]}>Edit</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => forget(anomalyKey!)} hitSlop={8}>
            <Text style={[detailStyles.contextLink, { color: c.subtext }]}>Forget</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (card.status === 'skipped' || !card.eligible) return null;

  return (
    <View style={[detailStyles.contextBox, { borderColor: c.border }]}>
      <Text style={[detailStyles.contextQuestion, { color: c.text }]}>
        Anything unusual about {formatObservationDate(card.localObservationDate)} that might help explain this?
      </Text>
      <Text style={[detailStyles.contextHint, { color: c.subtext }]}>Optional—add context if you know what made the day different.</Text>
      <View style={detailStyles.contextInputRow}>
        <TextInput
          style={[detailStyles.contextInput, { color: c.text, borderColor: c.border }, voiceState === 'recording' && detailStyles.contextInputRecording]}
          placeholder={voiceState === 'recording' ? 'Listening… release to send' : 'Your answer…'}
          placeholderTextColor={c.subtext}
          value={text}
          onChangeText={setText}
          editable={voiceState === 'idle' && !saving}
          multiline
          autoCorrect
          spellCheck
        />
        {voiceAvailable ? (
          <Pressable onPressIn={voicePressIn} onPressOut={voicePressOut} hitSlop={8} style={detailStyles.micBtn}>
            <Text style={{ fontSize: 18 }}>{voiceState === 'recording' ? '🔴' : '🎙️'}</Text>
          </Pressable>
        ) : null}
      </View>
      {errored ? <Text style={[detailStyles.contextError, { color: '#FF6B6B' }]}>Couldn’t save — try again.</Text> : null}
      <View style={detailStyles.contextActionsRow}>
        <TouchableOpacity onPress={() => submit(text)} disabled={!text.trim() || saving} hitSlop={8}>
          <Text style={[detailStyles.contextLink, { color: c.accent }, (!text.trim() || saving) && { opacity: 0.4 }]}>
            {saving ? 'Saving…' : editing ? 'Save' : 'Add context'}
          </Text>
        </TouchableOpacity>
        {!editing ? (
          <>
            <TouchableOpacity onPress={() => nothingUnusual(anomalyKey!)} disabled={saving} hitSlop={8}>
              <Text style={[detailStyles.contextLink, { color: c.subtext }]}>Nothing unusual</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => skip(anomalyKey!)} disabled={saving} hitSlop={8}>
              <Text style={[detailStyles.contextLink, { color: c.subtext }]}>Skip</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity onPress={() => { setEditing(false); setText(''); }} hitSlop={8}>
            <Text style={[detailStyles.contextLink, { color: c.subtext }]}>Cancel</Text>
          </TouchableOpacity>
        )}
      </View>
      {voiceState === 'thinking' ? <ActivityIndicator style={{ marginTop: spacing.xs }} /> : null}
    </View>
  );
}

function InsightDetailModal({ insight, onClose }: { insight: Insight; onClose: () => void }) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const tier = EVIDENCE_TIER_LABEL[insight.type] ?? 'Observation';
  const sample = sampleWindowFrom(insight.evidence);
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <SafeAreaView style={[detailStyles.root, { backgroundColor: c.background }]}>
        <View style={[detailStyles.header, { borderBottomColor: c.border }]}>
          <Text style={[detailStyles.tier, { color: c.accent }]}>{tier}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={10}>
            <Text style={[detailStyles.close, { color: c.subtext }]}>Done</Text>
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={detailStyles.content}>
          <Text style={[detailStyles.title, { color: c.text }]}>{insight.title}</Text>
          {insight.detail ? <Text style={[detailStyles.detail, { color: c.subtext }]}>{insight.detail}</Text> : null}
          {sample ? <Text style={[detailStyles.sample, { color: c.subtext }]}>{sample}</Text> : null}
          <AnomalyContextPrompt insight={insight} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const detailStyles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: spacing.md, borderBottomWidth: 1 },
  tier: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  close: { fontSize: 15, fontWeight: '600' },
  content: { padding: spacing.lg, gap: spacing.sm },
  title: { fontSize: 20, fontWeight: '700', lineHeight: 27 },
  detail: { fontSize: 15, lineHeight: 22, marginTop: spacing.sm },
  sample: { fontSize: 12, marginTop: spacing.md, fontStyle: 'italic' },
  contextBox: { marginTop: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, gap: spacing.sm },
  contextQuestion: { fontSize: 15, fontWeight: '600', lineHeight: 21 },
  contextHint: { fontSize: 12, marginTop: -4 },
  contextInputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  contextInput: { flex: 1, borderWidth: 1, borderRadius: radius.md, padding: spacing.sm, fontSize: 15, minHeight: 44 },
  contextInputRecording: { borderColor: '#FF6B6B' },
  micBtn: { padding: spacing.sm },
  contextActionsRow: { flexDirection: 'row', gap: spacing.lg, flexWrap: 'wrap' },
  contextLink: { fontSize: 14, fontWeight: '600' },
  contextAnswer: { fontSize: 15, lineHeight: 21, fontStyle: 'italic' },
  contextError: { fontSize: 13 },
});

/**
 * Health tab redesign (audit rec #4) — "Worth knowing": at most 2 ranked
 * health developments (never the full findings feed), each with a direct
 * drill-in to that exact insight. Ranking/dedup is pure
 * (mobile/src/lib/healthWorthKnowing.ts) over the server-curated
 * `healthInsights` the landing page already received — no new insight
 * generation, no re-ranking authority.
 */
function WorthKnowingCard({ insights }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Insight | null>(null);

  const top = selectWorthKnowing(insights).filter((i) => !i.dismissKey || !hidden.has(i.dismissKey));
  if (top.length === 0) return null;

  const dismiss = (ins: Insight) => {
    const key = ins.dismissKey;
    if (!key) return;
    setHidden((prev) => new Set(prev).add(key));
    fetchWithTimeout(INSIGHT_DISMISS_URL, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ key, title: ins.title }) }, 8000).catch(() => {});
  };

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="💡" title="Worth knowing" tint="violet" />
      {top.map((ins, idx) => (
        <TouchableOpacity
          key={ins.dismissKey ?? ins.title}
          onPress={() => setDetail(ins)}
          activeOpacity={0.7}
          style={[styles.row, idx > 0 && { borderTopWidth: 1, borderTopColor: c.border }]}
        >
          <View style={styles.rowBody}>
            <Text style={[styles.title, { color: c.text }]}>{ins.title}</Text>
            {ins.detail ? <Text style={[styles.detail, { color: c.subtext }]} numberOfLines={2}>{ins.detail}</Text> : null}
          </View>
          <View style={styles.rowActions}>
            {ins.dismissKey ? (
              <TouchableOpacity onPress={() => dismiss(ins)} hitSlop={8} style={styles.dismissBtn}>
                <Text style={[styles.dismissText, { color: c.subtext }]}>×</Text>
              </TouchableOpacity>
            ) : null}
            <Text style={[styles.chevron, { color: c.border }]}>›</Text>
          </View>
        </TouchableOpacity>
      ))}
      {detail ? <InsightDetailModal insight={detail} onClose={() => setDetail(null)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm, gap: spacing.sm },
  rowBody: { flex: 1 },
  title: { ...typography.body, fontWeight: '600', fontSize: 14 },
  detail: { ...typography.caption, fontSize: 12, lineHeight: 17, marginTop: 2 },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  dismissBtn: { padding: 4 },
  dismissText: { fontSize: 16, fontWeight: '600' },
  chevron: { fontSize: 18, fontWeight: '300' },
});

const WorthKnowingCardMemo = React.memo(WorthKnowingCard);
export { WorthKnowingCardMemo as WorthKnowingCard };
