import React from 'react';
import { Modal, View, Text, StyleSheet, ScrollView, TouchableOpacity, useColorScheme, SafeAreaView } from 'react-native';
import { getColors, spacing, typography } from '../theme';
import { CheckinCard } from './CheckinCard';
import { HabitsCard } from './HabitsCard';
import { ContextCard } from './ContextCard';

interface Props {
  visible: boolean;
  onClose: () => void;
}

// Daily check-in sheet: the two logging cards (mood/energy/focus + habit stack)
// live here instead of cluttering the Today scroll. Contents mount only while
// open so each card fetches today's state fresh on every open.
export function CheckinModal({ visible, onClose }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={[styles.root, { backgroundColor: c.background }]}>
        <View style={[styles.header, { borderBottomColor: c.border }]}>
          <Text style={[styles.title, { color: c.text }]}>Daily Check-in</Text>
          <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.closeBtn}>
            <Text style={[styles.closeTxt, { color: c.subtext }]}>✕</Text>
          </TouchableOpacity>
        </View>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {visible && (
            <>
              <CheckinCard />
              <HabitsCard />
              <ContextCard />
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
  },
  title: { fontSize: 20, fontWeight: '700', letterSpacing: -0.4 },
  closeBtn: { padding: spacing.xs },
  closeTxt: { fontSize: 18, fontWeight: '600' },
  content: { paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: spacing.xl },
});
