import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, useColorScheme, AppState, Pressable, Alert } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { getColors, spacing, radius, typography, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';
import { ANNOTATIONS_URL, ANNOTATIONS_ACTIVE_URL, authHeaders, fetchWithTimeout, localTz, localDateStr } from '../config';

type Preset = { emoji: string; category: string; label: string };
const PRESETS: Preset[] = [
  { emoji: '✈️', category: 'travel', label: 'Travel' },
  { emoji: '🤒', category: 'illness', label: 'Feeling sick' },
  { emoji: '😴', category: 'sleep', label: 'Poor sleep' },
  { emoji: '🌙', category: 'late_night', label: 'Late night' },
  { emoji: '🍷', category: 'alcohol', label: 'Drinking' },
  { emoji: '🔥', category: 'stress', label: 'High stress' },
  { emoji: '📅', category: 'deadline', label: 'Big deadline' },
  { emoji: '🎉', category: 'social', label: 'Social event' },
  { emoji: '🧘', category: 'rest', label: 'Rest day' },
];

type Logged = { id: string; category: string; label: string; end_ts?: string | null };

function isExtended(end_ts?: string | null): boolean {
  if (!end_ts) return false;
  return (new Date(end_ts).getTime() - Date.now()) / 3600000 > 48;
}

// Individual chip with spring-scale press and haptic feedback.
function Chip({
  p, on, busy, extended, onTap, c,
}: {
  p: Preset;
  on: boolean;
  busy: boolean;
  extended?: boolean;
  onTap: () => void;
  c: ReturnType<typeof getColors>;
}) {
  const scale = useSharedValue(1);
  const chipAnimStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePress = () => {
    scale.value = withSpring(0.9, { damping: 10, stiffness: 400 }, () => {
      scale.value = withSpring(1, { damping: 12, stiffness: 300 });
    });
    Haptics.selectionAsync();
    onTap();
  };

  const amberOn = on && extended;
  const bgColor = amberOn ? '#FF9F0A' : on ? c.accent : 'transparent';
  const borderColor = amberOn ? '#FF9F0A' : on ? c.accent : c.border;

  return (
    <Pressable onPress={handlePress} disabled={busy}>
      <Animated.View
        style={[
          styles.chip,
          {
            borderColor,
            backgroundColor: bgColor,
            opacity: busy ? 0.5 : 1,
          },
          chipAnimStyle,
        ]}
      >
        <Text style={[styles.chipText, { color: on ? '#fff' : c.text }]}>
          {p.emoji} {p.label}{on ? (amberOn ? ' ↻' : ' ✓') : ''}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

export function ContextCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [logged, setLogged] = useState<Logged[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [noteDays, setNoteDays] = useState(0); // 0 = today only
  const fetchDateRef = useRef('');

  // Use device timezone so the day resets at local midnight even when travelling.
  function todayLocal(): string {
    return localDateStr();
  }

  function startOfTodayISO(): string {
    return `${localDateStr()}T00:00:00`;
  }

  async function fetchToday() {
    fetchDateRef.current = todayLocal();
    try {
      // Use the /active endpoint — same overlapping() query the briefing uses — so
      // multi-day annotations (e.g. a travel note from last week with a future end_ts)
      // are visible here and can be deleted rather than invisibly polluting the brief.
      const res = await fetchWithTimeout(ANNOTATIONS_ACTIVE_URL, { headers: authHeaders() });
      if (!res.ok) return;
      const { annotations } = await res.json();
      if (!Array.isArray(annotations)) return;
      setLogged(annotations.map((a: any) => ({ id: a.id, category: a.category, label: a.label, end_ts: a.end_ts ?? null })));
    } catch {
      // offline — show presets unmarked
    }
  }

  useEffect(() => { fetchToday(); }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && fetchDateRef.current !== todayLocal()) {
        setLogged([]);
        setNote('');
        setFailed(false);
        fetchToday();
      }
    });
    return () => sub.remove();
  }, []);

  const isLogged = (label: string) => logged.some((l) => l.label === label);
  const getLogged = (label: string) => logged.find((l) => l.label === label);

  async function log(category: string, label: string) {
    if (saving) return;
    setSaving(label);
    setFailed(false);
    try {
      const res = await fetchWithTimeout(ANNOTATIONS_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ startTs: new Date().toISOString(), category, label }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const { id } = await res.json();
      setLogged((prev) => [{ id, category, label }, ...prev]);
    } catch {
      setFailed(true);
    } finally {
      setSaving(null);
    }
  }

  async function unlog(id: string, label: string) {
    if (saving) return;
    setSaving(label);
    setFailed(false);
    try {
      const res = await fetchWithTimeout(`${ANNOTATIONS_URL}/${id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      setLogged((prev) => prev.filter((l) => l.id !== id));
    } catch {
      setFailed(true);
    } finally {
      setSaving(null);
    }
  }

  function endOfDay(daysFromNow: number): Date {
    const d = new Date();
    d.setDate(d.getDate() + daysFromNow);
    d.setHours(23, 59, 59, 0);
    return d;
  }

  async function logNote() {
    const text = note.trim();
    if (!text) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSaving(text);
    setFailed(false);
    try {
      const res = await fetchWithTimeout(ANNOTATIONS_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          startTs: new Date().toISOString(),
          endTs: endOfDay(noteDays).toISOString(),
          category: 'note',
          label: text,
        }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const { id } = await res.json();
      setLogged((prev) => [{ id, category: 'note', label: text }, ...prev]);
      setNote('');
      setNoteDays(0);
    } catch {
      setFailed(true);
    } finally {
      setSaving(null);
    }
  }

  function startEdit(id: string, currentLabel: string) {
    setEditingId(id);
    setEditText(currentLabel);
  }

  async function saveEdit() {
    const text = editText.trim();
    if (!text || !editingId) { setEditingId(null); return; }
    setSaving(editingId);
    try {
      const res = await fetchWithTimeout(`${ANNOTATIONS_URL}/${editingId}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ label: text }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      setLogged((prev) => prev.map((l) => l.id === editingId ? { ...l, label: text } : l));
    } catch {
      setFailed(true);
    } finally {
      setSaving(null);
      setEditingId(null);
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setEditText('');
  }

  return (
    <View style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <SectionHeader emoji="📝" title="Anything going on today?" />
      <Text style={[styles.hint, { color: c.subtext }]}>
        Tap to log — tap again to remove. NormOS uses it to explain your numbers.
      </Text>

      <View style={styles.chips}>
        {PRESETS.map((p) => {
          const on = isLogged(p.label);
          const busy = saving === p.label;
          return (
            <Chip
              key={p.label}
              p={p}
              on={on}
              busy={busy}
              extended={on ? isExtended(getLogged(p.label)?.end_ts) : false}
              c={c}
              onTap={() => {
                if (on) {
                  const entry = getLogged(p.label);
                  if (entry) unlog(entry.id, p.label);
                } else {
                  log(p.category, p.label);
                }
              }}
            />
          );
        })}
      </View>

      <View style={styles.noteRow}>
        <TextInput
          style={[styles.noteInput, { color: c.text, borderColor: c.border }]}
          placeholder="Something else…"
          placeholderTextColor={c.subtext}
          value={note}
          onChangeText={setNote}
          returnKeyType="done"
          onSubmitEditing={logNote}
        />
        <TouchableOpacity
          onPress={logNote}
          disabled={!note.trim() || !!saving}
          style={[styles.addBtn, { backgroundColor: c.accent, opacity: note.trim() ? 1 : 0.4 }]}
        >
          <Text style={styles.addBtnText}>Add</Text>
        </TouchableOpacity>
      </View>
      {note.trim().length > 0 && (
        <View style={styles.durationRow}>
          {[{label:'Today',days:0},{label:'Tomorrow',days:1},{label:'3 days',days:3},{label:'1 week',days:7}].map((opt) => (
            <TouchableOpacity
              key={opt.days}
              onPress={() => setNoteDays(opt.days)}
              style={[styles.durationBtn, {
                borderColor: noteDays === opt.days ? c.accent : c.border,
                backgroundColor: noteDays === opt.days ? c.accentSoft : 'transparent',
              }]}
            >
              <Text style={[styles.durationBtnTxt, { color: noteDays === opt.days ? c.accent : c.subtext }]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {logged.filter((l) => !PRESETS.some((p) => p.label === l.label)).map((l) => (
        <View key={l.id} style={styles.customRow}>
          {editingId === l.id ? (
            <View style={styles.editRow}>
              <TextInput
                style={[styles.editInput, { color: c.text, borderColor: c.accent }]}
                value={editText}
                onChangeText={setEditText}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={saveEdit}
              />
              <TouchableOpacity onPress={saveEdit} disabled={saving === l.id} style={[styles.editSaveBtn, { backgroundColor: c.accent }]}>
                <Text style={styles.editSaveTxt}>{saving === l.id ? '…' : 'Save'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={cancelEdit} hitSlop={8} style={styles.editCancelBtn}>
                <Text style={[styles.editCancelTxt, { color: c.subtext }]}>✕</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.customNoteRow}>
              <Text style={[styles.customText, { color: c.subtext }]} numberOfLines={3}>✓ {l.label}</Text>
              <View style={styles.noteActions}>
                <TouchableOpacity onPress={() => startEdit(l.id, l.label)} hitSlop={8} style={styles.noteAction}>
                  <Text style={[styles.noteActionTxt, { color: c.accent }]}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => unlog(l.id, l.label)} hitSlop={8} style={styles.noteAction}>
                  <Text style={[styles.noteActionTxt, { color: c.subtext }]}>✕</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      ))}

      {failed && <Text style={styles.failed}>Couldn't save — check your connection and try again.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md },
  hint: { ...typography.caption, fontSize: 13, marginBottom: spacing.md, lineHeight: 19 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chipText: { ...typography.body, fontSize: 14, fontWeight: '600' },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  durationRow: { flexDirection: 'row', gap: spacing.xs, marginTop: spacing.xs },
  durationBtn: { flex: 1, borderWidth: 1, borderRadius: radius.md, paddingVertical: 5, alignItems: 'center' },
  durationBtnTxt: { fontSize: 11, fontWeight: '600' },
  noteInput: {
    flex: 1,
    ...typography.body,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  addBtn: { borderRadius: radius.md, paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.lg },
  addBtnText: { ...typography.body, fontWeight: '700', color: '#fff' },
  customRow: { marginTop: spacing.sm },
  customNoteRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.sm },
  customText: { ...typography.caption, fontSize: 13, flex: 1, lineHeight: 18 },
  noteActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingTop: 1 },
  noteAction: { paddingHorizontal: 2 },
  noteActionTxt: { fontSize: 13, fontWeight: '600' },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  editInput: { flex: 1, ...typography.body, fontSize: 13, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 5 },
  editSaveBtn: { borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 5 },
  editSaveTxt: { color: '#fff', fontSize: 13, fontWeight: '700' },
  editCancelBtn: { paddingHorizontal: 2 },
  editCancelTxt: { fontSize: 14, fontWeight: '600' },
  failed: { ...typography.caption, color: '#C0392B', marginTop: spacing.sm },
});
