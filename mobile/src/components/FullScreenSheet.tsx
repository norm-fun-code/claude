import React from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity, ScrollView, useColorScheme, SafeAreaView } from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';

interface Props {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * Shared full-screen presentation for the Health tab's three drill-ins
 * (Training, Patterns & experiments, Health history — audit rec #4's
 * "focused destinations without adding another bottom-navigation tab").
 * Consistent with the app's existing Modal-based navigation (CheckinModal,
 * WeeklyReviewModal, MetricDetailSheet) rather than introducing a new
 * navigation library/pattern.
 */
export function FullScreenSheet({ visible, title, onClose, children }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <SafeAreaView style={[styles.root, { backgroundColor: c.background }]}>
        <View style={[styles.header, { borderBottomColor: c.border }]}>
          <Text style={[styles.title, { color: c.text }]}>{title}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={10} style={styles.closeBtn}>
            <Text style={[styles.closeText, { color: c.subtext }]}>Done</Text>
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1,
  },
  title: { ...typography.title, fontSize: 18, fontWeight: '700' },
  closeBtn: { paddingVertical: 6, paddingHorizontal: 10 },
  closeText: { fontSize: 15, fontWeight: '600' },
  scrollContent: { padding: spacing.md, paddingBottom: spacing.xl },
});
