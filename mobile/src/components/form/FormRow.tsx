import React from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useColors, spacing, fontScale, fontWeight } from '../../theme';
import { resolveListRowShape, type ListRowPosition } from '../ui/listRowStyles';

interface FormRowProps {
  label?: string;
  children?: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  rightAccessory?: React.ReactNode;
  style?: ViewStyle;
  vertical?: boolean;
  required?: boolean;
  /** 由 FormSection 注入：决定本行下方是否画 hairline 分隔线 */
  position?: ListRowPosition;
}

/**
 * 表单行的基础布局 —— 度量与 `ui/ListRow` 完全一致
 * （minHeight 48 / 左右 spacing.lg / 上下 spacing.md / 行间左缩进 hairline），
 * 保证 FormSection 里混排 FormRow 与 ListRow 时不会出现两套行高。
 */
export function FormRow({
  label,
  children,
  onPress,
  disabled,
  rightAccessory,
  style,
  vertical,
  required,
  position = 'only',
}: FormRowProps) {
  const colors = useColors();
  const shape = resolveListRowShape(position);

  const body = (
    <View
      style={[
        styles.row,
        vertical ? styles.rowVertical : null,
        style,
        disabled ? styles.disabled : null,
      ]}
    >
      {label ? (
        <Text
          style={[
            styles.label,
            { color: colors.foreground },
            vertical ? styles.labelVertical : null,
          ]}
          numberOfLines={vertical ? 0 : 1}
        >
          {label}
          {required ? <Text style={{ color: colors.destructive }}> *</Text> : null}
        </Text>
      ) : null}
      <View style={[styles.content, vertical ? styles.contentVertical : null]}>{children}</View>
      {rightAccessory}
    </View>
  );

  return (
    <View>
      {onPress ? (
        <Pressable
          onPress={disabled ? undefined : onPress}
          android_ripple={{ color: colors.muted }}
          style={({ pressed }) => (pressed && !disabled ? { backgroundColor: colors.accent } : null)}
        >
          {body}
        </Pressable>
      ) : (
        body
      )}
      {shape.showSeparator ? (
        <View style={[styles.separator, { backgroundColor: colors.border }]} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowVertical: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  disabled: {
    opacity: 0.5,
  },
  label: {
    ...fontScale.base,
    fontWeight: fontWeight.regular,
    flexShrink: 0,
    marginRight: spacing.md,
  },
  labelVertical: {
    marginRight: 0,
    marginBottom: spacing.xs,
  },
  content: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  contentVertical: {
    justifyContent: 'flex-start',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing.lg,
  },
});
