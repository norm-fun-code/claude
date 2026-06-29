import React, { useState } from 'react';
import { View } from 'react-native';
import { Sparkline } from './Sparkline';

// Width-measuring wrapper around the Skia Sparkline — fills its container so call
// sites don't have to know the pixel width (the raw Sparkline needs an explicit
// width). For fixed-width spots, wrap this in a fixed-width View.
export function Trend({ values, height = 34, color, max = 60 }: {
  values: number[]; height?: number; color?: string; max?: number;
}) {
  const [w, setW] = useState(0);
  const data = (values || []).filter((v) => Number.isFinite(v)).slice(-max);
  if (data.length < 2) return null;
  return (
    <View style={{ height, width: '100%' }} onLayout={(e) => setW(Math.round(e.nativeEvent.layout.width))}>
      {w > 1 && <Sparkline values={data} width={w} height={height} color={color} />}
    </View>
  );
}
