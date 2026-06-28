import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { bandGradient, glow } from '../theme';

interface Props {
  /** Animated 0–100 score (counts up, shows "/ 100"). Ignored if `grade` is set. */
  score?: number;
  /** A static letter/short text (e.g. an A/B/C grade) — no count-up, no "/ 100". */
  grade?: string | null;
  band?: 'green' | 'yellow' | 'red' | string | null;
  size?: number;
  /** Small uppercase label inside the orb (e.g. the band name). */
  label?: string | null;
}

/**
 * A living "orb" — a band-tinted gradient sphere with a colored glow, a soft
 * sheen and a spring entrance. The signature hero element: depth + motion +
 * meaningful color, no flat circle. Renders an animated SCORE (count-up + /100)
 * or a static GRADE letter, sharing one visual language.
 */
export function RecoveryOrb({ score, grade, band, size = 100, label }: Props) {
  const colors = bandGradient[band || 'neutral'] || bandGradient.neutral;
  const target = Math.max(0, Math.round(score ?? 0));
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
      style={[glow(colors[1], 0.42, 18), { width: size, height: size, borderRadius: r, transform: [{ scale }], opacity }]}
    >
      <LinearGradient
        colors={colors}
        start={{ x: 0.2, y: 0.0 }}
        end={{ x: 0.8, y: 1.0 }}
        style={[styles.orb, { width: size, height: size, borderRadius: r }]}
      >
        {/* soft top sheen — a lit-sphere highlight that fades out, not a hard blob */}
        <LinearGradient
          colors={['rgba(255,255,255,0.40)', 'rgba(255,255,255,0.06)', 'rgba(255,255,255,0)']}
          start={{ x: 0.35, y: 0 }}
          end={{ x: 0.5, y: 0.72 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        {/* crisp inner ring for a clean edge */}
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { borderRadius: r, borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)' }]}
        />
        {grade != null ? (
          <Text style={[styles.score, { fontSize: Math.round(size * 0.5) }]}>{grade}</Text>
        ) : (
          <>
            <Text style={[styles.score, { fontSize: Math.round(size * 0.32) }]}>{display}</Text>
            <Text style={styles.unit}>/ 100</Text>
          </>
        )}
        {label ? <Text style={styles.label}>{label}</Text> : null}
      </LinearGradient>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  orb: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  score: { color: '#FFFFFF', fontWeight: '800', letterSpacing: -1, marginBottom: -3 },
  unit: { color: 'rgba(255,255,255,0.82)', fontSize: 10.5, fontWeight: '700' },
  label: { color: '#FFFFFF', fontSize: 9.5, fontWeight: '800', letterSpacing: 0.8, marginTop: 2, textTransform: 'uppercase' },
});
