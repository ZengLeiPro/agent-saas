import React, { Children, cloneElement, isValidElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors, spacing, fontScale, fontWeight } from '../../theme';
import { Card } from '../ui/Card';
import { resolveListRowPosition, type ListRowPosition } from '../ui/listRowStyles';

interface FormSectionProps {
  header?: string;
  footer?: string;
  children: React.ReactNode;
  required?: boolean;
}

/**
 * 分组卡片 —— 复用 `ui/Card`（flush）+ `listRowStyles` 的分组规则：
 * 卡片本身负责圆角与裁切，行的首尾/分隔由 `position` 下发给每个 Form* 行
 * （与 `ui/ListRowGroup` 同一套语义，两者可以在同一张卡里混排）。
 */
export function FormSection({ header, footer, children, required }: FormSectionProps) {
  const colors = useColors();
  const items = Children.toArray(children).filter(isValidElement) as React.ReactElement<{
    position?: ListRowPosition;
  }>[];

  return (
    <View style={styles.wrapper}>
      {header ? (
        <Text style={[styles.header, { color: colors.mutedForeground }]}>
          {header.toUpperCase()}
          {required ? <Text style={{ color: colors.destructive }}> *</Text> : null}
        </Text>
      ) : null}
      <Card flush style={styles.card}>
        {items.map((child, index) =>
          cloneElement(child, {
            key: child.key ?? index,
            position: resolveListRowPosition(index, items.length),
          }),
        )}
      </Card>
      {footer ? (
        <Text style={[styles.footer, { color: colors.mutedForeground }]}>{footer}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginBottom: spacing['2xl'],
  },
  header: {
    ...fontScale.xs,
    fontWeight: fontWeight.semibold,
    letterSpacing: 0.5,
    paddingHorizontal: spacing.xl,
    marginBottom: spacing.sm,
  },
  footer: {
    ...fontScale.xs,
    paddingHorizontal: spacing.xl,
    marginTop: spacing.sm,
  },
  card: {
    marginHorizontal: spacing.lg,
  },
});
