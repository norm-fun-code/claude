import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withRepeat, withSequence, Easing, runOnJS,
} from 'react-native-reanimated';
import { FONTS } from '../theme';

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning, Norm';
  if (h < 17) return 'Good afternoon, Norm';
  return 'Good evening, Norm';
}

interface Props {
  ready: boolean;       // the app's first data is loaded (feed will be stable on reveal)
  onDone: () => void;
}

// A premium cold-open welcome: a purple→silver gradient with the time-based
// greeting typed out, held over the (async) feed assembly, then faded away to
// reveal a fully-settled Today tab. This is what makes cold open feel smooth —
// you never see the cards mount or the evening brief insert; it's all hidden
// behind this, and lifts only once everything's in place.
export function WelcomeScreen({ ready, onDone }: Props) {
  const greeting = getGreeting();
  const [len, setLen] = useState(0);            // typewriter progress
  const [minElapsed, setMinElapsed] = useState(false);

  const opacity = useSharedValue(1);
  const cursor = useSharedValue(1);

  // Typewriter — reveal one character at a time.
  useEffect(() => {
    if (len >= greeting.length) return;
    const t = setTimeout(() => setLen((n) => n + 1), 52);
    return () => clearTimeout(t);
  }, [len, greeting.length]);

  // Blinking cursor.
  useEffect(() => {
    cursor.value = withRepeat(withSequence(withTiming(0, { duration: 450 }), withTiming(1, { duration: 450 })), -1, false);
  }, [cursor]);

  // Minimum on-screen time so the typed greeting is actually savored; a hard cap
  // so a slow/failed data load can never strand the user on this screen.
  useEffect(() => {
    const min = setTimeout(() => setMinElapsed(true), 1400);
    const cap = setTimeout(() => dismiss(), 4200);
    return () => { clearTimeout(min); clearTimeout(cap); };
  }, []);

  const dismissed = useRef(false);
  const [fading, setFading] = useState(false);
  function dismiss() {
    if (dismissed.current) return; // guard against double-trigger (ready vs. cap)
    dismissed.current = true;
    setFading(true); // let touches pass through to the Today tab during the dissolve
    // Slow, luxurious cross-dissolve into the Today tab underneath (~2.4s).
    opacity.value = withTiming(0, { duration: 2400, easing: Easing.inOut(Easing.quad) }, (finished) => {
      if (finished) runOnJS(onDone)();
    });
  }

  // Dismiss once the greeting is fully typed, the minimum time has passed, and the
  // feed's data is ready — so the reveal lands on a stable screen.
  useEffect(() => {
    if (ready && minElapsed && len >= greeting.length) dismiss();
  }, [ready, minElapsed, len, greeting.length]);

  const rootStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const cursorStyle = useAnimatedStyle(() => ({ opacity: cursor.value }));

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, rootStyle]} pointerEvents={fading ? 'none' : 'auto'}>
      <LinearGradient
        colors={['#4B44D6', '#7A73FF', '#A8A3E6', '#D9DAE7']}
        locations={[0, 0.42, 0.74, 1]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* soft top sheen for a silvery highlight */}
      <LinearGradient
        colors={['rgba(255,255,255,0.28)', 'rgba(255,255,255,0)']}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.center}>
        <Text style={styles.greeting}>
          {greeting.slice(0, len)}
          <Animated.Text style={[styles.cursor, cursorStyle]}>|</Animated.Text>
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { zIndex: 1000, elevation: 1000 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  greeting: {
    fontFamily: FONTS.display,
    fontSize: 32,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: -0.4,
    textAlign: 'center',
    textShadowColor: 'rgba(40,30,90,0.25)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 12,
  },
  cursor: { fontFamily: FONTS.display, fontSize: 32, color: 'rgba(255,255,255,0.85)' },
});
