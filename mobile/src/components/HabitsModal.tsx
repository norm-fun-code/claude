import React from 'react';
import {
  Modal, View, Text, StyleSheet, Pressable, ScrollView, useColorScheme, Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { getColors, spacing, radius } from '../theme';
import { HabitsCard } from './HabitsCard';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function HabitsModal({ visible, onClose }: Props) {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={[styles.sheet, { backgroundColor: c.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Drag handle */}
        <View style={styles.handleWrap}>
          <View style={[styles.handle, { backgroundColor: c.border }]} />
        </View>

        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <HabitsCard />
          <Pressable
            onPress={onClose}
            style={[styles.doneBtn, { backgroundColor: c.accent }]}
          >
            <Text style={styles.doneBtnText}>Done</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, paddingHorizontal: spacing.lg },
  handleWrap: { alignItems: 'center', paddingTop: spacing.sm, paddingBottom: spacing.xs },
  handle: { width: 36, height: 4, borderRadius: 2 },
  scroll: { paddingBottom: spacing.xl },
  doneBtn: {
    width: '100%',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  doneBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
