import React from 'react';
import { View } from 'react-native';

interface Props {
  /** One entry per day, oldest→newest. true = done that day. */
  values: boolean[];
  activeColor?: string;
  inactiveColor?: string;
  size?: number;
  gap?: number;
  max?: number;
}

// A compact adherence strip — filled dot for a done day, hollow for a miss. Shows
// the PATTERN ("which days slipped") that a "11/13 days" number hides. Pure RN.
export function DotRow({
  values,
  activeColor = '#635BFF',
  inactiveColor = 'rgba(60,60,67,0.16)',
  size = 9,
  gap = 4,
  max = 14,
}: Props) {
  const data = (values || []).slice(-max);
  if (!data.length) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap }}>
      {data.map((on, i) => (
        <View
          key={i}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: on ? activeColor : 'transparent',
            borderWidth: on ? 0 : 1.5,
            borderColor: inactiveColor,
          }}
        />
      ))}
    </View>
  );
}
