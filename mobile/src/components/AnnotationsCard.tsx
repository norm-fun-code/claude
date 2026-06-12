import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, TextInput, useColorScheme, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';
import { ANNOTATIONS_URL, authHeaders, fetchWithTimeout } from '../config';

const CATEGORIES = ['travel', 'illness', 'deadline', 'relationship', 'life', 'other'] as const;
type Category = typeof CATEGORIES[number];

const CATEGORY_LABELS: Record<Category, string> = {
  travel: '✈️ Travel', illness: '🤒 Illness', deadline: '⏰ Deadline',
  relationship: '💙 Relationship', life: '🌊 Life event', other: '📌 Other',
};

interface Annotation {
  id: string;
  category: Category;
  label: string;
  note: string | null;
  start_ts: string;
  end_ts: string | null;
}

export function AnnotationsCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [category, setCategory] = useState<Category>('life');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      // Only load today's annotations — context clears at midnight so the card
      // never shows stale events from prior days.
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const res = await fetchWithTimeout(`${ANNOTATIONS_URL}?from=${startOfToday.toISOString()}`, { headers: authHeaders() });
      if (!res.ok) return;
      const d = await res.json();
      setAnnotations(d.annotations ?? []);
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!label.trim()) return;
    setSaving(true);
    try {
      const now = new Date();
      const endOfToday = new Date(now);
      endOfToday.setHours(23, 59, 59, 0);
      const res = await fetchWithTimeout(ANNOTATIONS_URL, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({
          category,
          label: label.trim(),
          startTs: now.toISOString(),
          endTs: endOfToday.toISOString(),
        }),
      });
      if (res.ok) { setModalVisible(false); setLabel(''); load(); }
    } catch {} finally { setSaving(false); }
  }

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="📌" title="Life Context" />
      {annotations.length === 0 ? (
        <Text style={[styles.empty, { color: c.subtext }]}>
          Tag what's going on — travel, illness, stress — so insights stay accurate.
        </Text>
      ) : (
        <View style={styles.chips}>
          {annotations.slice(0, 5).map(a => (
            <View key={a.id} style={[styles.chip, { backgroundColor: c.accentSoft, borderColor: c.border }]}>
              <Text style={[styles.chipText, { color: c.accent }]}>
                {CATEGORY_LABELS[a.category] ?? a.category} · {a.label}
              </Text>
            </View>
          ))}
        </View>
      )}
      <TouchableOpacity
        onPress={() => setModalVisible(true)}
        style={[styles.addBtn, { borderColor: c.border }]}
      >
        <Text style={[styles.addBtnText, { color: c.subtext }]}>+ Add context</Text>
      </TouchableOpacity>

      <Modal visible={modalVisible} transparent animationType="slide" onRequestClose={() => setModalVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={styles.overlay}>
          <View style={[styles.sheet, { backgroundColor: c.card, borderColor: c.border }]}>
            <Text style={[styles.sheetTitle, { color: c.text }]}>What's going on?</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.catScroll}>
              {CATEGORIES.map(cat => (
                <TouchableOpacity
                  key={cat}
                  onPress={() => setCategory(cat)}
                  style={[styles.catChip, { borderColor: cat === category ? c.accent : c.border, backgroundColor: cat === category ? c.accentSoft : 'transparent' }]}
                >
                  <Text style={[styles.catChipText, { color: cat === category ? c.accent : c.subtext }]}>
                    {CATEGORY_LABELS[cat]}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TextInput
              style={[styles.labelInput, { color: c.text, borderColor: c.border, backgroundColor: isDark ? '#1C1C1A' : '#F9F8F6' }]}
              value={label}
              onChangeText={setLabel}
              placeholder="e.g. Work trip to NYC"
              placeholderTextColor={c.subtext}
            />
            <View style={styles.sheetBtns}>
              <TouchableOpacity onPress={() => setModalVisible(false)} style={[styles.sheetBtn, { borderColor: c.border }]}>
                <Text style={[styles.sheetBtnTxt, { color: c.subtext }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={save} disabled={saving || !label.trim()} style={[styles.sheetBtn, { backgroundColor: c.accent, borderColor: c.accent }]}>
                <Text style={[styles.sheetBtnTxt, { color: '#FFF' }]}>{saving ? 'Saving…' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  empty: { fontSize: 13, lineHeight: 19, fontStyle: 'italic', marginBottom: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
  chip: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm, borderWidth: 1 },
  chipText: { fontSize: 13, fontWeight: '500' },
  addBtn: { paddingVertical: spacing.sm, borderRadius: radius.md, borderWidth: 1, alignItems: 'center' },
  addBtnText: { fontSize: 14, fontWeight: '500' },
  overlay: { flex: 1, backgroundColor: '#00000055', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: 1, borderLeftWidth: 1, borderRightWidth: 1, padding: spacing.lg, paddingBottom: spacing.xl + 10 },
  sheetTitle: { fontSize: 18, fontWeight: '700', marginBottom: spacing.md },
  catScroll: { marginBottom: spacing.md },
  catChip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: 20, borderWidth: 1, marginRight: spacing.sm },
  catChipText: { fontSize: 13, fontWeight: '600' },
  labelInput: { borderWidth: 1, borderRadius: 10, padding: spacing.sm, fontSize: 15, marginBottom: spacing.md },
  sheetBtns: { flexDirection: 'row', gap: spacing.sm },
  sheetBtn: { flex: 1, borderRadius: 10, borderWidth: 1, paddingVertical: spacing.sm + 2, alignItems: 'center' },
  sheetBtnTxt: { fontSize: 15, fontWeight: '600' },
});
