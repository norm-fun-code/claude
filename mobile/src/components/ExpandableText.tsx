import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, TextStyle, type NativeSyntheticEvent, type TextLayoutEventData } from 'react-native';

interface Props {
  text: string;
  collapsedLines?: number;
  style?: TextStyle | TextStyle[];
  accentColor: string;
  /** Prefix for the accessibility label, e.g. "Hypothesis" or "Goal". */
  a11yPrefix?: string;
}

// Shared truncate-with-tap-to-expand primitive (see CommitmentsCard.tsx for
// the original pattern this generalizes).
//
// Measurement contract (this is the whole reason for the hidden Text below):
// `onTextLayout` fired by a <Text numberOfLines={N}> reports only the CLAMPED
// lines on iOS — at most N of them — so testing `lines.length > collapsedLines`
// against the visible, already-clamped Text can NEVER be true. That is exactly
// how this component shipped: `truncated` stayed false forever, so no More/Less
// affordance ever rendered and the TouchableOpacity stayed `disabled` — tapping
// any truncated text (Since This Morning, Worth a look, Experiments) silently
// did nothing. The true line count must come from an UNCLAMPED copy of the same
// text at the same width, which is what the zero-opacity measurer renders. It is
// absolutely positioned so it contributes no height, and unmounts once measured.
export function ExpandableText({ text, collapsedLines = 2, style, accentColor, a11yPrefix }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [measured, setMeasured] = useState(false);
  const canExpand = truncated;

  // Re-measure whenever the content (or the clamp) changes — a cached
  // verdict from previous text would be wrong for new text.
  useEffect(() => {
    setMeasured(false);
    setTruncated(false);
    setExpanded(false);
  }, [text, collapsedLines]);

  const handleMeasure = (e: NativeSyntheticEvent<TextLayoutEventData>) => {
    setTruncated(e.nativeEvent.lines.length > collapsedLines);
    setMeasured(true);
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
      <View>
        <Text style={style} numberOfLines={expanded ? undefined : collapsedLines}>
          {text}
        </Text>
        {!measured && (
          <View pointerEvents="none" style={styles.measurer}>
            <Text
              style={style}
              onTextLayout={handleMeasure}
              accessible={false}
              importantForAccessibility="no-hide-descendants"
            >
              {text}
            </Text>
          </View>
        )}
      </View>
      {canExpand && (
        <Text style={[styles.moreLess, { color: accentColor }]}>{expanded ? 'Less' : 'More'}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  moreLess: { fontSize: 11, fontWeight: '700', marginTop: 2 },
  // Same width as the visible copy (left/right pinned), no clamp, invisible,
  // and out of layout flow so it can never affect the rendered height.
  measurer: { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 },
});

export default ExpandableText;
