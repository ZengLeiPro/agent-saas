/**
 * Simple flex-wrap card grid driven by window width (md=2, lg=3, else 1).
 * Phone callers keep a single vertical stack via columns === 1.
 */
import React, { Children, useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { cardGridColumns } from '../../lib/cardGrid';
import { spacing } from '../../theme';

export type ResponsiveCardGridProps = {
  children: React.ReactNode;
  gap?: number;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

export function ResponsiveCardGrid({
  children,
  gap = spacing.md,
  testID = 'responsive-card-grid',
  style,
}: ResponsiveCardGridProps) {
  const { width } = useBreakpoint();
  const columns = cardGridColumns(width);
  const items = Children.toArray(children).filter(Boolean);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        stack: { gap },
        row: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          marginHorizontal: -(gap / 2),
        },
        cell: {
          width: `${100 / columns}%`,
          paddingHorizontal: gap / 2,
          marginBottom: gap,
        },
      }),
    [columns, gap],
  );

  if (columns <= 1) {
    return (
      <View style={[styles.stack, style]} testID={testID}>
        {items}
      </View>
    );
  }

  return (
    <View style={[styles.row, style]} testID={testID} accessibilityLabel={`${columns} 列卡片`}>
      {items.map((child, index) => (
        <View key={index} style={styles.cell}>
          {child}
        </View>
      ))}
    </View>
  );
}
