import React, { useState } from 'react';
import { Text, TouchableOpacity, StyleSheet, TextStyle, type NativeSyntheticEvent, type TextLayoutEventData } from 'react-native';

interface Props {
  text: string;
  collapsedLines?: number;
  style?: TextStyle | TextStyle[];
  accentColor: string;
  /** Prefix for the accessibility label, e.g. "Hypothesis" or "Goal". */
  a11yPrefix?: string;
}

// Shared truncate-with-tap-to-expand primitive (see CommitmentsCard.tsx for
// the original pattern this generalizes). onTextLayout reports the true
// wrapped line count at render width, not a string-length guess — so
// truncation only appears when content actually overflows.
export function ExpandableText({ text, collapsedLines = 2, style, accentColor, a11yPrefix }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const canExpand = expanded || truncated;

  const handleLayout = (e: NativeSyntheticEvent<TextLayoutEventData>) => {
    if (!expanded && e.nativeEvent.lines.length > collapsedLines) setTruncated(true);
  };

  return (
    <TouchableOpacity
      activeOpacity={canExpand ? 0.6 : 1}
      onPress={() => { if (canExpand) setExpanded((v) => !v); }}
      disabled={!canExpand}
      accessibilityRole={canExpand ? 'button' : undefined}
      accessibilityLabel={canExpand && a11yPrefix ? `${a11yPrefix}: ${text}` : undefined}
      accessibilityHint={canExpand ? (expanded ? 'Double tap to collapse' : 'Double tap to expand') : undefined}
      accessibilityState={canExpand ? { expanded } : undefined}
    >
      <Text style={style} numberOfLines={expanded ? undefined : collapsedLines} onTextLayout={handleLayout}>
        {text}
      </Text>
      {truncated && (
        <Text style={[styles.moreLess, { color: accentColor }]}>{expanded ? 'Less' : 'More'}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  moreLess: { fontSize: 11, fontWeight: '700', marginTop: 2 },
});

export default ExpandableText;
