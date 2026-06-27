import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { bandGradient, glow } from '../theme';

interface Props {
  score: number;
  band?: 'green' | 'yellow' | 'red' | string | null;
  size?: number;
  /** Small uppercase label inside the orb (e.g. the band name). */
  label?: string | null;
}

/**
 * The recovery score as a living "orb" — a band-tinted gradient sphere with a
 * colored glow, a soft sheen, a spring entrance and a count-up. The signature
 * hero element: depth + motion + meaningful color, no flat circle.
 */
export function RecoveryOrb({ score, band, size = 100, label }: Props) {
  const colors = bandGradient[band || 'neutral'] || bandGradient.neutral;
  const target = Math.max(0, Math.round(score));
  const [display, setDisplay] = useState(0);

  const scale = useRef(new Animated.Value(0.86)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 6, tension: 120 }),
      Animated.timing(opacity, { toValue: 1, duration: 320, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();

    // Count up to the score (easeOutCubic) for a satisfying reveal.
    const start = Date.now();
    const dur = 750;
    let raf: number;
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // re-run if the score changes (e.g. after a self-report submit)
  }, [target]);

  const r = size / 2;
  return (
    <Animated.View
      style={[glow(colors[1]), { width: size, height: size, borderRadius: r, transform: [{ scale }], opacity }]}
    >
      <LinearGradient
        colors={colors}
        start={{ x: 0.15, y: 0.0 }}
        end={{ x: 0.85, y: 1.0 }}
        style={[styles.orb, { width: size, height: size, borderRadius: r }]}
      >
        {/* top-left sheen for a "lit sphere" read */}
        <View
          style={[
            styles.sheen,
            { width: size * 0.52, height: size * 0.52, borderRadius: size * 0.26, top: size * 0.08, left: size * 0.1 },
          ]}
        />
        <Text style={[styles.score, { fontSize: Math.round(size * 0.34) }]}>{display}</Text>
        <Text style={styles.unit}>/ 100</Text>
        {label ? <Text style={styles.label}>{label}</Text> : null}
      </LinearGradient>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  orb: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  sheen: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.22)' },
  score: { color: '#FFFFFF', fontWeight: '800', letterSpacing: -1.5, marginBottom: -4 },
  unit: { color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '700' },
  label: { color: '#FFFFFF', fontSize: 9.5, fontWeight: '800', letterSpacing: 0.8, marginTop: 2, textTransform: 'uppercase' },
});
