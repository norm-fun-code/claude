import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
  useColorScheme,
} from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';
import { SHOP_URL, authHeaders } from '../config';

interface ShopResult {
  query: string;
  status: string;
  message?: string;
  detail?: string;
  pick?: { title: string; price?: string | null; seller?: string | null; image?: string | null };
  cart?: { continueUrl?: string | null; total?: string | null } | null;
  results?: { title: string; price?: string | null; seller?: string | null }[];
}

// Shopping agent (UCP). You say "reorder Aloha bars"; the agent searches
// participating merchants, builds a cart, and hands you a checkout link — you
// tap to pay. Never pays on its own.
export function ShopCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ShopResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const message = input.trim();
    if (!message || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(SHOP_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ message }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Server ${res.status}`);
      setResult(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  const checkoutUrl = result?.cart?.continueUrl || null;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="🛒" title="Shopping Agent" />
      <Text style={[styles.hint, { color: c.subtext }]}>
        Tell me what to reorder — I'll find it and build a cart you can check out.
      </Text>

      <View style={[styles.inputRow, { borderColor: c.border }]}>
        <TextInput
          style={[styles.input, { color: c.text }]}
          placeholder='e.g. "reorder Aloha protein bars"'
          placeholderTextColor={c.subtext}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={send}
          returnKeyType="send"
          editable={!loading}
        />
        <TouchableOpacity onPress={send} disabled={loading || !input.trim()}>
          <Text style={[styles.send, { color: input.trim() ? c.accent : c.subtext }]}>
            {loading ? '…' : 'Go'}
          </Text>
        </TouchableOpacity>
      </View>

      {loading && (
        <View style={styles.loading}>
          <ActivityIndicator color={c.subtext} />
          <Text style={[styles.loadingText, { color: c.subtext }]}>Searching merchants…</Text>
        </View>
      )}

      {error && <Text style={[styles.error, { color: '#C0392B' }]}>{error}</Text>}

      {result && !loading && (
        <View style={styles.result}>
          {result.pick ? (
            <View style={[styles.pick, { borderColor: c.border, backgroundColor: isDark ? '#0E2E4D' : '#FAFAF8' }]}>
              <Text style={[styles.pickTitle, { color: c.text }]}>{result.pick.title}</Text>
              <Text style={[styles.pickMeta, { color: c.subtext }]}>
                {[result.pick.price, result.pick.seller].filter(Boolean).join('  ·  ') || ' '}
              </Text>
              {result.cart?.total ? (
                <Text style={[styles.pickMeta, { color: c.subtext }]}>Cart total: {result.cart.total}</Text>
              ) : null}
            </View>
          ) : null}

          <Text style={[styles.message, { color: c.subtext }]}>{result.message}</Text>

          {checkoutUrl ? (
            <TouchableOpacity
              style={[styles.checkout, { backgroundColor: c.accent }]}
              onPress={() => Linking.openURL(checkoutUrl)}
              activeOpacity={0.85}
            >
              <Text style={styles.checkoutText}>Review & Check Out  ↗</Text>
            </TouchableOpacity>
          ) : null}

          {result.results && result.results.length > 1 ? (
            <View style={styles.alts}>
              <Text style={[styles.altsLabel, { color: c.subtext }]}>Other matches</Text>
              {result.results.slice(1, 4).map((r, i) => (
                <Text key={i} style={[styles.altItem, { color: c.text }]} numberOfLines={1}>
                  • {r.title}
                  {r.price ? `  (${r.price})` : ''}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  hint: { ...typography.caption, fontSize: 13, marginBottom: spacing.md, lineHeight: 19 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    gap: spacing.sm,
  },
  input: { flex: 1, ...typography.body, paddingVertical: spacing.sm },
  send: { ...typography.body, fontWeight: '700' },
  loading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  loadingText: { ...typography.caption, fontSize: 13 },
  error: { ...typography.body, marginTop: spacing.md },
  result: { marginTop: spacing.md, gap: spacing.sm },
  pick: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md },
  pickTitle: { ...typography.body, fontWeight: '600', marginBottom: 2 },
  pickMeta: { ...typography.caption, fontSize: 13 },
  message: { ...typography.body, lineHeight: 22 },
  checkout: {
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  checkoutText: { ...typography.body, fontWeight: '700', color: '#fff' },
  alts: { marginTop: spacing.sm, gap: 2 },
  altsLabel: { ...typography.caption, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  altItem: { ...typography.caption, fontSize: 13 },
});
