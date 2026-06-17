import React, { useEffect } from 'react';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withDelay,
} from 'react-native-reanimated';

interface Props {
  delay?: number;
  distance?: number;
  children: React.ReactNode;
  style?: any;
}

const SPRING = { damping: 22, stiffness: 200, mass: 0.8 };

// Mount animation: starts invisible (opacity 0, slight translateY), springs
// into place after `delay` ms. Uses useSharedValue so the initial state is
// committed to native before the animation starts — no first-frame flash.
export function AnimatedEntry({ delay = 0, distance = 16, children, style }: Props) {
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(distance);

  useEffect(() => {
    // Double-rAF: ensures native has painted the initial opacity-0 state
    // before starting the spring. This eliminates the one-frame flash.
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        opacity.value = withDelay(delay, withSpring(1, SPRING));
        translateY.value = withDelay(delay, withSpring(0, SPRING));
      });
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return <Animated.View style={[animStyle, style]}>{children}</Animated.View>;
}
