import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Minus, Plus } from 'lucide-react-native';
import { useColors, spacing, radius, fontScale, fontWeight } from '../../theme';
import { ICON_SIZE, ICON_STROKE } from '../../lib/icons';
import type { ListRowPosition } from '../ui/listRowStyles';
import { FormRow } from './FormRow';

interface FormStepperRowProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onValueChange: (value: number) => void;
  disabled?: boolean;
  format?: (value: number) => string;
  position?: ListRowPosition;
}

/** 数值步进器：±按钮用 lucide 图标（不再用全角字符冒充按钮）。 */
export function FormStepperRow({
  label,
  value,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  onValueChange,
  disabled,
  format,
  position,
}: FormStepperRowProps) {
  const colors = useColors();
  const atMin = disabled || value <= min;
  const atMax = disabled || value >= max;

  const apply = (next: number) => {
    const clamped = Math.min(max, Math.max(min, next));
    if (clamped !== value) onValueChange(clamped);
  };

  return (
    <FormRow label={label} disabled={disabled} position={position}>
      <View style={styles.container}>
        <Text style={[styles.value, { color: colors.foreground }]}>
          {format ? format(value) : String(value)}
        </Text>
        <View style={[styles.buttons, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`减少${label}`}
            onPress={() => apply(value - step)}
            disabled={atMin}
            style={styles.btn}
          >
            <Minus
              size={ICON_SIZE.action}
              color={atMin ? colors.mutedForeground : colors.foreground}
              strokeWidth={ICON_STROKE.default}
            />
          </Pressable>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`增加${label}`}
            onPress={() => apply(value + step)}
            disabled={atMax}
            style={styles.btn}
          >
            <Plus
              size={ICON_SIZE.action}
              color={atMax ? colors.mutedForeground : colors.foreground}
              strokeWidth={ICON_STROKE.default}
            />
          </Pressable>
        </View>
      </View>
    </FormRow>
  );
}

/** 步进按钮的固定尺寸：保证左右两个按钮等宽且够 44pt 触达带 */
const STEP_BTN_WIDTH = 40;
const STEP_BTN_HEIGHT = 32;
const VALUE_MIN_WIDTH = 60;

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  value: {
    ...fontScale.base,
    fontWeight: fontWeight.regular,
    minWidth: VALUE_MIN_WIDTH,
    textAlign: 'right',
  },
  buttons: {
    flexDirection: 'row',
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  btn: {
    width: STEP_BTN_WIDTH,
    height: STEP_BTN_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    width: StyleSheet.hairlineWidth,
  },
});
