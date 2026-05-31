import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
  Image,
  useColorScheme,
} from 'react-native';
import { getColors, spacing, radius, typography } from '../theme';
import { SectionHeader } from './SectionHeader';
import { SHOP_URL, authHeaders } from '../config';

interface Product {
  id: string;
  title: string;
  price?: string | null;
  seller?: string | null;
  image?: string | null;
  url?: string | null;
  web?: boolean; // true = discovery-only link-out (e.g. Amazon); false = UCP cart-able
}
interface HistItem {
  id: string;
  title: string;
  business?: string | null;
  variantId?: string | null;
  price?: string | null;
  image?: string | null;
}

// Shopping agent (UCP), fully native. Discover products by describing what you
// want ("white running sneakers under $100"), browse results in-app, tap one to
// build a cart — only the final checkout leaves the app. Reorder row up top
// pulls from your shop history.
export function ShopCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Product[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [building, setBuilding] = useState<string | null>(null); // product id being carted
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [checkoutFor, setCheckoutFor] = useState<string | null>(null);

  const [history, setHistory] = useState<HistItem[]>([]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`${SHOP_URL}/history`, { headers: authHeaders() });
      const json = await res.json();
      setHistory(json.orders ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const discover = async (message: string) => {
    const m = message.trim();
    if (!m || loading) return;
    setLoading(true);
    setError(null);
    setNote(null);
    setResults([]);
    setCheckoutUrl(null);
    try {
      const res = await fetch(`${SHOP_URL}/discover`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ message: m }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Server ${res.status}`);
      setResults(json.results ?? []);
      setNote(json.message ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  const addToCart = async (p: { id: string; title: string; seller?: string | null; price?: string | null; image?: string | null }, business?: string | null, variantId?: string | null) => {
    setBuilding(p.id);
    setError(null);
    setCheckoutUrl(null);
    try {
      const res = await fetch(`${SHOP_URL}/cart`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          business: business ?? p.seller,
          variantId: variantId ?? p.id,
          item: { title: p.title, price: p.price, image: p.image, id: p.id },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Server ${res.status}`);
      if (json.cart?.continueUrl) {
        setCheckoutUrl(json.cart.continueUrl);
        setCheckoutFor(p.title);
      } else {
        setError(json.message || 'Could not build a cart for this item.');
      }
      loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build cart.');
    } finally {
      setBuilding(null);
    }
  };

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <SectionHeader emoji="🛒" title="Shopping Agent" />
      <Text style={[styles.hint, { color: c.subtext }]}>
        Describe what you want — I’ll surface options. Tap one to build a cart; you only leave the app to check out.
      </Text>

      <View style={[styles.inputRow, { borderColor: c.border }]}>
        <TextInput
          style={[styles.input, { color: c.text }]}
          placeholder='e.g. "white running sneakers under $100"'
          placeholderTextColor={c.subtext}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={() => discover(input)}
          returnKeyType="search"
          editable={!loading}
        />
        <TouchableOpacity onPress={() => discover(input)} disabled={loading || !input.trim()}>
          <Text style={[styles.send, { color: input.trim() ? c.accent : c.subtext }]}>
            {loading ? '…' : 'Search'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Reorder row */}
      {history.length > 0 && results.length === 0 && !loading && (
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.subtext }]}>Reorder</Text>
          {history.slice(0, 6).map((h) => (
            <View key={h.id} style={[styles.row, { borderColor: c.border }]}>
              <View style={styles.rowMain}>
                <Text style={[styles.rowTitle, { color: c.text }]} numberOfLines={1}>{h.title}</Text>
                {h.price ? <Text style={[styles.rowMeta, { color: c.subtext }]}>{h.price}</Text> : null}
              </View>
              <TouchableOpacity
                style={[styles.rowBtn, { borderColor: c.accent }]}
                onPress={() => addToCart({ id: h.variantId || h.id, title: h.title, seller: h.business, price: h.price, image: h.image }, h.business, h.variantId)}
                disabled={building === (h.variantId || h.id)}
              >
                <Text style={[styles.rowBtnText, { color: c.accent }]}>
                  {building === (h.variantId || h.id) ? '…' : 'Reorder'}
                </Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {loading && (
        <View style={styles.loading}>
          <ActivityIndicator color={c.subtext} />
          <Text style={[styles.loadingText, { color: c.subtext }]}>Searching merchants…</Text>
        </View>
      )}

      {error && <Text style={[styles.error]}>{error}</Text>}
      {note && !loading && results.length > 0 && (
        <Text style={[styles.note, { color: c.subtext }]}>{note}</Text>
      )}

      {/* Checkout banner (only appears after a cart is built) */}
      {checkoutUrl && (
        <TouchableOpacity
          style={[styles.checkout, { backgroundColor: c.accent }]}
          onPress={() => Linking.openURL(checkoutUrl)}
          activeOpacity={0.85}
        >
          <Text style={styles.checkoutText} numberOfLines={1}>
            Check out {checkoutFor ? `“${checkoutFor}”` : ''}  ↗
          </Text>
        </TouchableOpacity>
      )}

      {/* Results grid (native) */}
      {results.map((p) => (
        <View key={p.id} style={[styles.product, { borderColor: c.border }]}>
          {p.image ? (
            <Image source={{ uri: p.image }} style={styles.thumb} resizeMode="cover" />
          ) : (
            <View style={[styles.thumb, styles.thumbBlank, { backgroundColor: isDark ? '#1A1A18' : '#F0F0EE' }]}>
              <Text style={{ color: c.subtext, fontSize: 22 }}>🛍️</Text>
            </View>
          )}
          <View style={styles.productMain}>
            <Text style={[styles.productTitle, { color: c.text }]} numberOfLines={2}>{p.title}</Text>
            <Text style={[styles.productMeta, { color: c.subtext }]} numberOfLines={1}>
              {[p.price, p.seller].filter(Boolean).join('  ·  ')}
            </Text>
            {p.web ? (
              // Web/Amazon: discovery-only — open the product page to buy.
              <TouchableOpacity
                style={[styles.addBtn, styles.linkBtn, { borderColor: c.accent }]}
                onPress={() => p.url && Linking.openURL(p.url)}
                activeOpacity={0.8}
              >
                <Text style={[styles.addBtnText, { color: c.accent }]}>Open ↗</Text>
              </TouchableOpacity>
            ) : (
              // UCP merchant: build a cart in-app.
              <TouchableOpacity
                style={[styles.addBtn, { backgroundColor: c.accent, opacity: p.seller ? 1 : 0.4 }]}
                onPress={() => addToCart(p)}
                disabled={!p.seller || building === p.id}
              >
                <Text style={styles.addBtnText}>
                  {building === p.id ? 'Building…' : p.seller ? 'Add to cart' : 'No checkout'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      ))}

      {note && !loading && results.length === 0 && (
        <Text style={[styles.note, { color: c.subtext }]}>{note}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  hint: { ...typography.caption, fontSize: 13, marginBottom: spacing.md, lineHeight: 19 },
  inputRow: {
    flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.xs, gap: spacing.sm,
  },
  input: { flex: 1, ...typography.body, paddingVertical: spacing.sm },
  send: { ...typography.body, fontWeight: '700' },
  section: { marginTop: spacing.md },
  sectionLabel: { ...typography.caption, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: spacing.xs },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1, borderRadius: radius.md, padding: spacing.sm, marginBottom: spacing.xs,
  },
  rowMain: { flex: 1, marginRight: spacing.sm },
  rowTitle: { ...typography.body, fontWeight: '500' },
  rowMeta: { ...typography.caption, fontSize: 12 },
  rowBtn: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  rowBtnText: { ...typography.caption, fontSize: 13, fontWeight: '600' },
  loading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  loadingText: { ...typography.caption, fontSize: 13 },
  error: { ...typography.body, color: '#C0392B', marginTop: spacing.md },
  note: { ...typography.caption, fontSize: 13, marginTop: spacing.md, lineHeight: 19 },
  checkout: { borderRadius: radius.md, paddingVertical: spacing.md, alignItems: 'center', marginTop: spacing.md },
  checkoutText: { ...typography.body, fontWeight: '700', color: '#fff' },
  product: {
    flexDirection: 'row', borderWidth: 1, borderRadius: radius.md, padding: spacing.sm,
    marginTop: spacing.sm, gap: spacing.md,
  },
  thumb: { width: 64, height: 64, borderRadius: radius.sm },
  thumbBlank: { alignItems: 'center', justifyContent: 'center' },
  productMain: { flex: 1, justifyContent: 'space-between' },
  productTitle: { ...typography.body, fontWeight: '600' },
  productMeta: { ...typography.caption, fontSize: 12, marginTop: 2 },
  addBtn: { borderRadius: radius.sm, paddingVertical: spacing.xs, alignItems: 'center', marginTop: spacing.xs },
  linkBtn: { borderWidth: 1, backgroundColor: 'transparent' },
  addBtnText: { ...typography.caption, fontSize: 13, fontWeight: '700', color: '#fff' },
});
