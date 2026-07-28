import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { layout, spacing } from '../theme';

interface Props {
  color: string;
  style?: ViewStyle;
}

/**
 * The small drag-handle bar every hand-rolled bottom sheet in the app
 * (CheckinModal, HabitsModal, MetricDetailSheet, RadarDetailSheet,
 * WeeklyReviewModal, WorkoutProgressionDetail) was independently redrawing
 * at the identical 36x4/radius-2 dimensions — one shared primitive instead
 * of six copies of the same three-property style object. Defaults to the
 * spacing.md gap below it every consumer already used; pass `style` to
 * override.
 */
function SheetHandle({ color, style }: Props) {
  return <View style={[styles.handle, { backgroundColor: color }, style]} />;
}

const styles = StyleSheet.create({
  handle: { ...layout.sheetHandle, alignSelf: 'center', marginBottom: spacing.md },
});

export default React.memo(SheetHandle);
