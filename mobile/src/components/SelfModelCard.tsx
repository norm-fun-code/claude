import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
  useColorScheme,
} from 'react-native';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { CONSOLIDATE_URL, GOALS_URL, authHeaders, fetchWithTimeout } from '../config';

interface GoalItem { id: string; title: string; targetDate: string | null }

interface Snapshot {
  wellbeing?: Record<string, { cur: number | null; prior: number | null }>;
  health?: Record<string, { cur: number | null; prior: number | null; goodWhen?: string }>;
  habits?: Record<string, { rate: number | null; label: string; scale?: number; streak?: number }>;
  wealth?: { netWorth: number | null; spendingMtd: number | null };
  goals?: number;
  goalsList?: GoalItem[];
  experiments?: { completed: unknown[]; running: unknown[] };
  findings?: number;
  topFindings?: { title: string }[];
}

interface SelfModel {
  content: string;
  generatedAt: string;
  kind: string;
  snapshot: Snapshot;
}

function ageLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 2) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function streakLabel(streak: number): string {
  if (streak <= 0) return '';
  if (streak === 1) return '1 wk';
  return `${streak} wks`;
}

function SelfModelCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [model, setModel] = useState<SelfModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [goalModalVisible, setGoalModalVisible] = useState(false);
  const [newGoalText, setNewGoalText] = useState('');
  const [savingGoal, setSavingGoal] = useState(false);
  // Local goals list — seeded from snapshot, updated optimistically
  const [goals, setGoals] = useState<GoalItem[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithTimeout(CONSOLIDATE_URL, { headers: authHeaders() }, 15000);
      if (res.ok) {
        const json = await res.json();
        const snap: Snapshot = json.snapshot ?? {};
        setModel({ content: json.content, generatedAt: json.generatedAt, kind: json.kind, snapshot: snap });
        setGoals(snap.goalsList ?? []);
      }
    } catch { /* best-effort */ } finally {
      setLoading(false);
    }
  }, []);

  const triggerConsolidate = useCallback(async () => {
    setConsolidating(true);
    try {
      const res = await fetchWithTimeout(CONSOLIDATE_URL, { method: 'POST', headers: authHeaders() }, 30000);
      if (res.ok) await load();
    } catch { /* best-effort */ } finally {
      setConsolidating(false);
    }
  }, [load]);

  useEffect(() => { load(); }, [load]);

  async function saveGoal() {
    const title = newGoalText.trim();
    if (!title) return;
    setSavingGoal(true);
    try {
      const res = await fetchWithTimeout(GOALS_URL, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ title }),
      });
      if (res.ok) {
        const json = await res.json();
        if (json.goal) {
          setGoals((prev) => [{ id: json.goal.id, title: json.goal.title, targetDate: null }, ...prev]);
        }
        setGoalModalVisible(false);
        setNewGoalText('');
      }
    } catch { /* best-effort */ } finally { setSavingGoal(false); }
  }

  async function completeGoal(id: string) {
    setGoals((prev) => prev.filter((g) => g.id !== id)); // optimistic
    try {
      await fetchWithTimeout(`${GOALS_URL}/${id}`, {
        method: 'PATCH', headers: authHeaders(),
        body: JSON.stringify({ status: 'done' }),
      });
    } catch { /* best-effort, server will sync on next consolidate */ }
  }

  const s = model?.snapshot ?? {};
  const habits = s.habits ? Object.values(s.habits).filter((h) => h.rate != null) : [];
  const confirmedCount = s.findings ?? 0;
  const runningCount = s.experiments?.running?.length ?? 0;
  const completedCount = s.experiments?.completed?.length ?? 0;
  const topFindings = s.topFindings ?? [];

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <View style={styles.headerRow}>
        <SectionHeader emoji="🧬" title="NormOS Profile" preserveCase />
        {model && (
          <Text style={[styles.age, { color: c.subtext }]}>Updated {ageLabel(model.generatedAt)}</Text>
        )}
      </View>

      {loading && !model && (
        <ActivityIndicator color={c.accent} style={{ marginTop: spacing.sm }} />
      )}

      {model && (
        <>
          {/* Stats strip */}
          {(confirmedCount + runningCount + completedCount + goals.length) > 0 && (
            <View style={[styles.stats, { borderColor: c.border }]}>
              <Stat label="CONFIRMED" value={String(confirmedCount)} sub="correlations" c={c} />
              <View style={[styles.statDivider, { backgroundColor: c.border }]} />
              <Stat label="RUNNING" value={String(runningCount)} sub="experiments" c={c} />
              <View style={[styles.statDivider, { backgroundColor: c.border }]} />
              <Stat label="COMPLETED" value={String(completedCount)} sub="experiments" c={c} />
              <View style={[styles.statDivider, { backgroundColor: c.border }]} />
              <Stat label="GOALS" value={String(goals.length)} sub="active" c={c} />
            </View>
          )}

          {/* Goals */}
          <View style={[styles.section, { borderTopColor: c.border }]}>
            <View style={styles.sectionTitleRow}>
              <Text style={[styles.sectionLabel, { color: c.subtext }]}>GOALS</Text>
              <TouchableOpacity onPress={() => setGoalModalVisible(true)} hitSlop={8}>
                <Text style={[styles.addGoalBtn, { color: c.accent }]}>+ Add</Text>
              </TouchableOpacity>
            </View>
            {goals.length === 0 ? (
              <Text style={[styles.emptyGoals, { color: c.subtext }]}>No active goals — add one to track your intentions here.</Text>
            ) : (
              goals.map((g) => (
                <View key={g.id} style={styles.goalRow}>
                  <TouchableOpacity onPress={() => completeGoal(g.id)} hitSlop={6} style={styles.goalCheck}>
                    <View style={[styles.checkbox, { borderColor: c.subtext }]} />
                  </TouchableOpacity>
                  <Text style={[styles.goalTitle, { color: c.text }]} numberOfLines={2}>{g.title}</Text>
                  {g.targetDate && (
                    <Text style={[styles.goalDate, { color: c.subtext }]}>
                      {new Date(g.targetDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </Text>
                  )}
                </View>
              ))
            )}
          </View>

          {/* Confirmed correlations */}
          {topFindings.length > 0 && (
            <View style={[styles.section, { borderTopColor: c.border }]}>
              <Text style={[styles.sectionLabel, { color: c.subtext }]}>WHAT THE DATA CONFIRMS</Text>
              {topFindings.map((f, i) => (
                <View key={i} style={styles.findingRow}>
                  <Text style={[styles.findingBullet, { color: c.accent }]}>↔</Text>
                  <Text style={[styles.findingTitle, { color: c.text }]}>{f.title}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Habits this week with streaks */}
          {habits.length > 0 && (
            <View style={[styles.section, { borderTopColor: c.border }]}>
              <Text style={[styles.sectionLabel, { color: c.subtext }]}>HABITS THIS WEEK</Text>
              {habits.map((h, i) => {
                const streak = h.streak ?? 0;
                const rate = h.rate ?? 0;
                const color = h.scale ? c.accent
                  : rate >= 80 ? c.green : rate < 50 ? c.red : c.yellow;
                return (
                  <View key={i} style={styles.habitRow}>
                    <Text style={[styles.habitLabel, { color: c.text }]}>{h.label}</Text>
                    <View style={styles.habitRight}>
                      {streak >= 2 && (
                        <View style={[styles.streakBadge, { backgroundColor: c.accentSoft }]}>
                          <Text style={[styles.streakText, { color: c.accent }]}>🔥 {streakLabel(streak)}</Text>
                        </View>
                      )}
                      {h.scale === 5 ? (
                        <Text style={[styles.habitScore, { color: color }]}>{rate}/5</Text>
                      ) : (
                        <Text style={[styles.habitScore, { color: color }]}>
                          {Math.round(rate / 100 * 7)}/7
                        </Text>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          )}

          {/* Full model text toggle */}
          <View style={[styles.section, { borderTopColor: c.border }]}>
            <TouchableOpacity onPress={() => setExpanded((e) => !e)} activeOpacity={0.7} style={styles.toggleRow}>
              <Text style={[styles.sectionLabel, { color: c.subtext }]}>FULL MODEL TEXT</Text>
              <Text style={[styles.toggleChevron, { color: c.subtext }]}>{expanded ? '▲' : '▼'}</Text>
            </TouchableOpacity>
            {expanded && (
              <ScrollView style={[styles.modelScroll, { backgroundColor: c.accentSoft, borderRadius: radius.sm }]} nestedScrollEnabled>
                <Text style={[styles.modelText, { color: c.text }]}>{model.content}</Text>
              </ScrollView>
            )}
          </View>
        </>
      )}

      <TouchableOpacity
        onPress={triggerConsolidate}
        disabled={consolidating || loading}
        style={[styles.btn, { borderColor: c.border, backgroundColor: c.accentSoft }]}
        activeOpacity={0.7}
      >
        {consolidating ? (
          <ActivityIndicator size="small" color={c.accent} />
        ) : (
          <Text style={[styles.btnText, { color: c.accent }]}>↺ Update profile</Text>
        )}
      </TouchableOpacity>

      {/* Add goal modal */}
      <Modal visible={goalModalVisible} transparent animationType="slide" onRequestClose={() => setGoalModalVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <View style={styles.overlay}>
            <View style={[styles.sheet, { backgroundColor: c.card, borderColor: c.border }]}>
              <Text style={[styles.sheetTitle, { color: c.text }]}>Add a goal</Text>
              <TextInput
                style={[styles.goalInput, { color: c.text, borderColor: c.border, backgroundColor: isDark ? '#1C1C1A' : '#F9F8F6' }]}
                value={newGoalText}
                onChangeText={setNewGoalText}
                placeholder="e.g. Sleep 8h consistently"
                placeholderTextColor={c.subtext}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={saveGoal}
                autoCorrect
                spellCheck
              />
              <View style={styles.sheetBtns}>
                <TouchableOpacity onPress={() => { setGoalModalVisible(false); setNewGoalText(''); }} style={[styles.sheetBtn, { borderColor: c.border }]}>
                  <Text style={[styles.sheetBtnTxt, { color: c.subtext }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={saveGoal} disabled={savingGoal || !newGoalText.trim()} style={[styles.sheetBtn, { backgroundColor: c.accent, borderColor: c.accent }]}>
                  <Text style={[styles.sheetBtnTxt, { color: '#FFF' }]}>{savingGoal ? 'Saving…' : 'Save'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function Stat({ label, value, sub, c }: { label: string; value: string; sub: string; c: ReturnType<typeof getColors> }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: c.subtext }]}>{label}</Text>
      <Text style={[styles.statValue, { color: c.text }]}>{value}</Text>
      <Text style={[styles.statSub, { color: c.subtext }]}>{sub}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
  age: { fontSize: 11, fontWeight: '500' },
  stats: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.sm, marginTop: spacing.xs, borderTopWidth: 1 },
  stat: { flex: 1, alignItems: 'center' },
  statDivider: { width: 1, marginVertical: 2 },
  statLabel: { fontSize: 8, fontWeight: '700', letterSpacing: 0.6, marginBottom: 2 },
  statValue: { fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  statSub: { fontSize: 9, fontWeight: '500' },
  section: { marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1 },
  sectionLabel: { ...typography.label, fontSize: 9, marginBottom: spacing.xs },
  sectionTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  addGoalBtn: { fontSize: 13, fontWeight: '600' },
  emptyGoals: { fontSize: 12, fontStyle: 'italic', lineHeight: 17 },
  goalRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: 6 },
  goalCheck: { padding: 2 },
  checkbox: { width: 16, height: 16, borderRadius: 4, borderWidth: 1.5 },
  goalTitle: { fontSize: 13, fontWeight: '500', flex: 1 },
  goalDate: { fontSize: 11 },
  findingRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs, marginBottom: 4 },
  findingBullet: { fontSize: 13, fontWeight: '700', marginTop: 1 },
  findingTitle: { fontSize: 13, flex: 1, lineHeight: 18 },
  habitRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 },
  habitLabel: { fontSize: 13, fontWeight: '500', flex: 1 },
  habitRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  streakBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm },
  streakText: { fontSize: 10, fontWeight: '600' },
  habitScore: { fontSize: 13, fontWeight: '600', minWidth: 28, textAlign: 'right' },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  toggleChevron: { fontSize: 11 },
  modelScroll: { maxHeight: 220, padding: spacing.sm },
  modelText: { fontSize: 12, lineHeight: 18, fontFamily: 'Courier' },
  btn: { marginTop: spacing.md, borderWidth: 1, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center' },
  btnText: { fontSize: 13, fontWeight: '600' },
  overlay: { flex: 1, backgroundColor: '#00000055', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: 1, borderLeftWidth: 1, borderRightWidth: 1, padding: spacing.lg, paddingBottom: spacing.xl + 10 },
  sheetTitle: { fontSize: 18, fontWeight: '700', marginBottom: spacing.md },
  goalInput: { borderWidth: 1, borderRadius: 10, padding: spacing.sm, fontSize: 15, marginBottom: spacing.md },
  sheetBtns: { flexDirection: 'row', gap: spacing.sm },
  sheetBtn: { flex: 1, borderRadius: 10, borderWidth: 1, paddingVertical: spacing.sm + 2, alignItems: 'center' },
  sheetBtnTxt: { fontSize: 15, fontWeight: '600' },
});

const SelfModelCardMemo = React.memo(SelfModelCard);
export { SelfModelCardMemo as SelfModelCard };
