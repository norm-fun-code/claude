import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ActivityIndicator,
  SafeAreaView,
  useColorScheme,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { getColors, spacing, radius, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';

// Your live financial-planner advisor, embedded. It runs the full projection
// model and stays in sync with your scenarios — nothing to duplicate here.
const ADVISOR_URL = 'https://claude-production-7130.up.railway.app/';

export function AdvisorCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, shadow(isDark)]}>
      <SectionHeader emoji="🧮" title="Financial Advisor" preserveCase />
      <Text style={[styles.blurb, { color: c.subtext }]}>
        Personalized Q&A grounded in your live financial plan, scenarios, and projections.
      </Text>
      <TouchableOpacity
        onPress={() => {
          setLoading(true);
          setOpen(true);
        }}
        style={[styles.btn, { backgroundColor: c.accent }]}
        activeOpacity={0.85}
      >
        <Text style={styles.btnText}>Ask your advisor →</Text>
      </TouchableOpacity>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: c.background }}>
          <View style={[styles.modalHeader, { borderBottomColor: c.border }]}>
            <Text style={[styles.modalTitle, { color: c.text }]}>Financial Advisor</Text>
            <TouchableOpacity onPress={() => setOpen(false)} hitSlop={12}>
              <Text style={[styles.close, { color: c.accent }]}>Done</Text>
            </TouchableOpacity>
          </View>
          <View style={{ flex: 1 }}>
            <WebView
              source={{ uri: ADVISOR_URL }}
              onLoadEnd={() => setLoading(false)}
              sharedCookiesEnabled
              thirdPartyCookiesEnabled
              domStorageEnabled
              originWhitelist={['*']}
              style={{ flex: 1, backgroundColor: c.background }}
            />
            {loading && (
              <View style={[styles.loading, { backgroundColor: c.background }]}>
                <ActivityIndicator color={c.accent} />
                <Text style={[styles.loadingText, { color: c.subtext }]}>Loading your advisor…</Text>
              </View>
            )}
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  blurb: { fontSize: 13, lineHeight: 19, marginBottom: spacing.md },
  btn: {
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  btnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
  },
  modalTitle: { fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  close: { fontSize: 16, fontWeight: '600' },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  loadingText: { fontSize: 13 },
});
