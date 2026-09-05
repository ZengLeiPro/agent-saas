import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors, spacing, radius, fontScale, fontWeight } from '../../theme';
import type { ListRowPosition } from '../ui/listRowStyles';
import { FormRow } from './FormRow';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface FormSegmentedRowProps<T extends string> {
  label?: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  position?: ListRowPosition;
}

/** 分段选择器：muted 底槽 + card 底的选中片，与 Web 的 tabs 语义一致。 */
export function FormSegmentedRow<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  position,
}: FormSegmentedRowProps<T>) {
  const colors = useColors();
  return (
    <FormRow label={label} disabled={disabled} position={position}>
      <View style={[styles.container, { backgroundColor: colors.muted }]}>
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <Pressable
              key={opt.value}
              accessibilityRole="button"
              accessibilityState={{ selected: active, disabled: !!disabled }}
              onPress={() => !disabled && onChange(opt.value)}
              style={[styles.segment, active ? { backgroundColor: colors.card } : null]}
            >
              <Text
                style={[
                  styles.segmentText,
                  {
                    color: active ? colors.foreground : colors.mutedForeground,
                    fontWeight: active ? fontWeight.semibold : fontWeight.regular,
                  },
                ]}
                numberOfLines={1}
              >
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </FormRow>
  );
}

/** 分段控件的最小宽度：三段中文标签不至于挤成两行 */
const SEGMENT_MIN_WIDTH = 180;

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    borderRadius: radius.lg,
    padding: 2,
    minWidth: SEGMENT_MIN_WIDTH,
  },
  segment: {
    flex: 1,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentText: {
    ...fontScale.sm,
  },
});
