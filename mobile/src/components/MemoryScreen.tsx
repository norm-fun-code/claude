import React, { useMemo, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, ActivityIndicator, Modal, useColorScheme, Alert } from 'react-native';
import { getColors, spacing, radius, typography, shadow, withAlpha, colors as themeColors } from '../theme';
import { useMemory, type MemoryItem, type MemoryCategory } from '../hooks/useMemory';

const CATEGORY_LABEL: Record<MemoryCategory, string> = {
  people_relationships: 'People',
  stable_facts_preferences: 'Facts & preferences',
  routines_classifications: 'Routines',
  goals_projects: 'Goals & projects',
  decisions_commitments: 'Decisions',
  time_bounded_events: 'Events',
  corrections_exclusions: 'Corrections',
  learned_beliefs: 'Learned patterns',
};

const CATEGORY_ORDER: MemoryCategory[] = [
  'stable_facts_preferences', 'people_relationships', 'routines_classifications',
  'goals_projects', 'decisions_commitments', 'time_bounded_events',
  'corrections_exclusions', 'learned_beliefs',
];

const STATE_COLOR: Record<string, string> = {
  active: themeColors.confirmedGreen, confirmed: themeColors.confirmedGreen, supported: '#3B9EFF', hypothesis: themeColors.subtext,
  expired: themeColors.subtext, superseded: themeColors.subtext, retracted: themeColors.subtext, retired: themeColors.subtext,
};

const EXPIRE_PRESETS: { label: string; days: number }[] = [
  { label: '1 week', days: 7 },
  { label: '1 month', days: 30 },
  { label: '3 months', days: 90 },
];

// Progressive disclosure detail sheet — provenance/lifecycle fields the
// first-glance card deliberately omits (per the UX spec: "the first view
// should show a clean statement and useful temporal label; provenance and
// lifecycle details can open in a sheet").
function DetailSheet({ item, visible, onClose, onCorrect, onForget, onConfirm, onMarkTemporary, secondary, c, isDark }: {
  item: MemoryItem | null; visible: boolean; onClose: () => void;
  onCorrect: (text: string) => void; onForget: () => void; onConfirm: () => void; onMarkTemporary: (days: number) => void;
  secondary: string; c: ReturnType<typeof getColors>; isDark: boolean;
}) {
  const [correcting, setCorrecting] = useState(false);
  const [draft, setDraft] = useState('');
  const [choosingExpiry, setChoosingExpiry] = useState(false);

  if (!item) return null;

  const confirmForget = () => {
    Alert.alert(
      'Forget this?',
      'NormOS will stop using this when reasoning. It stays visible here as history, but is no longer active.',
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Forget', style: 'destructive', onPress: onForget }],
    );
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[detailStyles.sheet, { backgroundColor: c.background }]}>
        <View style={[detailStyles.header, { borderBottomColor: c.border }]}>
          <Text style={[detailStyles.title, { color: c.text }]}>{CATEGORY_LABEL[item.category]}</Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <Text style={[detailStyles.done, { color: c.accent }]}>Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={detailStyles.content}>
          <Text style={[detailStyles.statement, { color: c.text }]}>{item.statement}</Text>
          <Text style={[detailStyles.line, { color: secondary }]}>{item.reason}</Text>
          {!!item.temporalLabel && <Text style={[detailStyles.line, { color: secondary }]}>{item.temporalLabel}</Text>}
          {item.retiredReason ? <Text style={[detailStyles.line, { color: secondary }]}>{item.retiredReason}</Text> : null}
          {item.confidence != null ? (
            <Text style={[detailStyles.line, { color: secondary }]}>Confidence: {Math.round(item.confidence * 100)}%</Text>
          ) : null}
          <Text style={[detailStyles.line, { color: secondary }]}>
            {item.eligibleForReasoning ? 'NormOS may use this when reasoning.' : 'Not currently used when reasoning.'}
          </Text>

          {correcting ? (
            <View style={detailStyles.editWrap}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder="What should this say instead?"
                placeholderTextColor={secondary}
                style={[detailStyles.input, { color: c.text, borderColor: c.border, backgroundColor: c.inputBackground }]}
                multiline
                autoCorrect
                spellCheck
                autoFocus
              />
              <View style={detailStyles.actionsRow}>
                <Pressable onPress={() => { setCorrecting(false); setDraft(''); }} hitSlop={8}>
                  <Text style={[detailStyles.actionText, { color: secondary }]}>Cancel</Text>
                </Pressable>
                <Pressable onPress={() => { if (draft.trim()) { onCorrect(draft.trim()); setCorrecting(false); setDraft(''); } }} hitSlop={8}>
                  <Text style={[detailStyles.actionText, { color: c.accent }]}>Save correction</Text>
                </Pressable>
              </View>
            </View>
          ) : choosingExpiry ? (
            <View style={detailStyles.actionsRow}>
              {EXPIRE_PRESETS.map((p) => (
                <Pressable key={p.label} onPress={() => { onMarkTemporary(p.days); setChoosingExpiry(false); }} hitSlop={6} style={[detailStyles.pill, { borderColor: c.border }]}>
                  <Text style={[detailStyles.actionText, { color: c.text }]}>{p.label}</Text>
                </Pressable>
              ))}
              <Pressable onPress={() => setChoosingExpiry(false)} hitSlop={6}>
                <Text style={[detailStyles.actionText, { color: secondary }]}>Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <View style={detailStyles.actionsRow}>
              {item.actions.canCorrect && (
                <Pressable onPress={() => { setDraft(item.statement); setCorrecting(true); }} hitSlop={6}>
                  <Text style={[detailStyles.actionText, { color: c.accent }]}>Correct</Text>
                </Pressable>
              )}
              {item.actions.canConfirm && (
                <Pressable onPress={onConfirm} hitSlop={6}>
                  <Text style={[detailStyles.actionText, { color: themeColors.confirmedGreen }]}>Confirm</Text>
                </Pressable>
              )}
              {item.actions.canMarkTemporary && (
                <Pressable onPress={() => setChoosingExpiry(true)} hitSlop={6}>
                  <Text style={[detailStyles.actionText, { color: c.text }]}>Mark temporary</Text>
                </Pressable>
              )}
              {item.actions.canForget && (
                <Pressable onPress={confirmForget} hitSlop={6}>
                  <Text style={[detailStyles.actionText, { color: '#FF6B6B' }]}>Forget</Text>
                </Pressable>
              )}
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

/**
 * Product audit rec #6 — "What NormOS knows". A calm, personal read/manage
 * surface over the SAME canonical context_assertions/beliefs stores every
 * other surface (Ask/Chief Brief/forecasts) already reads through
 * intelligence/context-resolver.js and store/beliefs.js — this screen adds
 * no new facts, no embeddings, no generated profile blob, just a categorized
 * human view with Correct/Forget/Mark-temporary/Confirm actions wired to the
 * real mutation endpoints (see useMemory.ts). Distinct from History (past
 * Ask conversations, reached via the adjacent "History" header button) —
 * deleting a conversation never touches anything shown here, and forgetting
 * something here never touches conversation transcripts.
 */
export function MemoryScreen() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const secondary = c.subtextStrong;
  const { active, historical, loading, loadError, load, correct, forget, confirm, markTemporary } = useMemory();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<MemoryCategory | null>(null);
  const [showHistorical, setShowHistorical] = useState(false);
  const [detailItem, setDetailItem] = useState<MemoryItem | null>(null);

  const matches = useCallback((item: MemoryItem) => {
    if (category && item.category !== category) return false;
    if (!query.trim()) return true;
    return item.statement.toLowerCase().includes(query.trim().toLowerCase());
  }, [category, query]);

  const filteredActive = useMemo(() => active.filter(matches), [active, matches]);
  const filteredHistorical = useMemo(() => historical.filter(matches), [historical, matches]);

  const presentCategories = useMemo(() => {
    const set = new Set([...active, ...historical].map((i) => i.category));
    return CATEGORY_ORDER.filter((k) => set.has(k));
  }, [active, historical]);

  const closeDetail = () => setDetailItem(null);
  const handleCorrect = async (text: string) => {
    if (!detailItem) return;
    if (await correct(detailItem, text)) closeDetail();
  };
  const handleForget = async () => {
    if (!detailItem) return;
    if (await forget(detailItem)) closeDetail();
  };
  const handleConfirm = async () => {
    if (!detailItem) return;
    if (await confirm(detailItem)) closeDetail();
  };
  const handleMarkTemporary = async (days: number) => {
    if (!detailItem) return;
    const effectiveEnd = new Date(Date.now() + days * 86400000).toISOString();
    if (await markTemporary(detailItem, effectiveEnd)) closeDetail();
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerBlock}>
        <Text style={[styles.header, { color: c.text }]}>What NormOS knows</Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search memory"
          placeholderTextColor={secondary}
          style={[styles.search, { color: c.text, borderColor: c.border, backgroundColor: c.card }]}
          autoCorrect={false}
          spellCheck={false}
          clearButtonMode="while-editing"
        />
        {presentCategories.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
            <Pressable onPress={() => setCategory(null)} style={[styles.chip, { borderColor: category === null ? c.accent : c.border, backgroundColor: category === null ? withAlpha(c.accent, 0.12) : 'transparent' }]}>
              <Text style={[styles.chipText, { color: category === null ? c.accent : secondary }]}>All</Text>
            </Pressable>
            {presentCategories.map((k) => (
              <Pressable key={k} onPress={() => setCategory(k)} style={[styles.chip, { borderColor: category === k ? c.accent : c.border, backgroundColor: category === k ? withAlpha(c.accent, 0.12) : 'transparent' }]}>
                <Text style={[styles.chipText, { color: category === k ? c.accent : secondary }]}>{CATEGORY_LABEL[k]}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}
      </View>

      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        {loading ? (
          <ActivityIndicator color={c.accent} style={{ marginTop: spacing.lg }} />
        ) : loadError ? (
          <View>
            <Text style={[styles.errorText, { color: '#FF6B6B' }]}>Couldn't load memory — check your connection.</Text>
            <Pressable onPress={load} hitSlop={6}>
              <Text style={[styles.retryText, { color: c.accent }]}>Retry</Text>
            </Pressable>
          </View>
        ) : filteredActive.length === 0 ? (
          <Text style={[styles.empty, { color: secondary }]}>
            {query || category ? 'Nothing matches.' : 'Nothing durable learned yet — stable facts, preferences, and corrections you share will show up here.'}
          </Text>
        ) : (
          filteredActive.map((item) => (
            <Pressable
              key={item.id}
              onPress={() => setDetailItem(item)}
              style={[styles.card, { backgroundColor: c.card }, shadow(isDark)]}
              accessibilityRole="button"
              accessibilityLabel={`${item.statement}. ${item.temporalLabel || item.reason}`}
            >
              <View style={styles.cardHead}>
                <View style={[styles.dot, { backgroundColor: STATE_COLOR[item.status] ?? c.subtext }]} />
                <Text style={[styles.categoryLabel, { color: secondary }]}>{CATEGORY_LABEL[item.category]}</Text>
              </View>
              <Text style={[styles.statement, { color: c.text }]}>{item.statement}</Text>
              <Text style={[styles.reason, { color: secondary }]} numberOfLines={1}>
                {item.temporalLabel ? `${item.temporalLabel} · ${item.reason}` : item.reason}
              </Text>
            </Pressable>
          ))
        )}

        {filteredHistorical.length > 0 && (
          <View style={styles.historicalWrap}>
            <Pressable onPress={() => setShowHistorical((s) => !s)} style={styles.historicalToggle} hitSlop={6}>
              <Text style={[styles.historicalToggleText, { color: secondary }]}>
                {showHistorical ? '▾' : '▸'} Expired & superseded ({filteredHistorical.length})
              </Text>
            </Pressable>
            {showHistorical && filteredHistorical.map((item) => (
              <Pressable
                key={item.id}
                onPress={() => setDetailItem(item)}
                style={[styles.card, styles.historicalCard, { backgroundColor: c.card }]}
                accessibilityRole="button"
                accessibilityLabel={`${item.statement}. ${item.temporalLabel}`}
              >
                <Text style={[styles.statement, { color: secondary }]}>{item.statement}</Text>
                <Text style={[styles.reason, { color: secondary }]} numberOfLines={1}>{item.temporalLabel}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>

      <DetailSheet
        item={detailItem}
        visible={detailItem != null}
        onClose={closeDetail}
        secondary={secondary}
        c={c}
        isDark={isDark}
        onCorrect={handleCorrect}
        onForget={handleForget}
        onConfirm={handleConfirm}
        onMarkTemporary={handleMarkTemporary}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  headerBlock: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, gap: spacing.sm },
  header: { fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  search: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 9, fontSize: 15 },
  chipsRow: { gap: spacing.sm, paddingVertical: 2, paddingBottom: spacing.sm },
  chip: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  chipText: { fontSize: 13, fontWeight: '600' },
  content: { padding: spacing.md, paddingTop: spacing.sm, gap: spacing.sm },
  card: { borderRadius: radius.lg, padding: spacing.md, gap: 4 },
  historicalCard: { opacity: 0.75 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  categoryLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.3, textTransform: 'uppercase' },
  statement: { ...typography.body, fontSize: 15, lineHeight: 21, fontWeight: '600' },
  reason: { fontSize: 13 },
  empty: { fontSize: 14, lineHeight: 21, marginTop: spacing.lg, textAlign: 'center' },
  errorText: { fontSize: 14, marginTop: spacing.lg, textAlign: 'center' },
  retryText: { fontSize: 14, fontWeight: '600', textAlign: 'center', marginTop: spacing.xs },
  historicalWrap: { marginTop: spacing.sm, gap: spacing.sm },
  historicalToggle: { paddingVertical: spacing.xs },
  historicalToggleText: { fontSize: 13, fontWeight: '600' },
});

const detailStyles = StyleSheet.create({
  sheet: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderBottomWidth: 1 },
  title: { fontSize: 17, fontWeight: '700' },
  done: { fontSize: 15, fontWeight: '600' },
  content: { padding: spacing.md, gap: spacing.sm },
  statement: { fontSize: 18, fontWeight: '700', lineHeight: 25 },
  line: { fontSize: 14, lineHeight: 20 },
  editWrap: { gap: spacing.sm, marginTop: spacing.sm },
  input: { borderWidth: 1, borderRadius: radius.md, padding: spacing.sm, fontSize: 15, minHeight: 70, textAlignVertical: 'top' },
  actionsRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm, flexWrap: 'wrap', alignItems: 'center' },
  actionText: { fontSize: 14, fontWeight: '600', minHeight: 32 },
  pill: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
});
