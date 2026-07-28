import React, { useRef } from 'react';
import { Text, StyleSheet, Pressable, Animated, ViewStyle, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { radius, glow, accentGradient } from '../theme';

interface Props {
  label: string;
  onPress: () => void;
  /** Override the gradient (e.g. a band gradient). Defaults to the brand accent. */
  gradient?: [string, string];
  style?: ViewStyle;
  size?: 'lg' | 'md';
  disabled?: boolean;
  loading?: boolean;
}

/**
 * The signature primary action: a gradient pill with a soft colored glow and a
 * springy press. One premium CTA language across the app.
 */
export function GradientButton({ label, onPress, gradient = accentGradient, style, size = 'lg', disabled, loading }: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const press = (to: number) =>
    Animated.spring(scale, { toValue: to, useNativeDriver: true, friction: 7, tension: 220 }).start();

  const inert = disabled || loading;
  return (
    <Animated.View style={[{ transform: [{ scale }], opacity: inert ? 0.55 : 1 }, glow(gradient[1], 0.38, 16), style]}>
      <Pressable
        disabled={inert}
        onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onPress(); }}
        onPressIn={() => press(0.97)}
        onPressOut={() => press(1)}
        accessibilityRole="button"
        accessibilityLabel={loading ? `${label}, loading` : label}
        accessibilityState={{ disabled: inert, busy: loading }}
      >
        <LinearGradient
          colors={gradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.btn, size === 'md' && styles.btnMd]}
        >
          {loading
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={[styles.label, size === 'md' && styles.labelMd]} allowFontScaling maxFontSizeMultiplier={1.5}>{label}</Text>}
        </LinearGradient>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  btn: { borderRadius: radius.lg, paddingVertical: 16, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  btnMd: { paddingVertical: 12 },
  label: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  labelMd: { fontSize: 15 },
});
