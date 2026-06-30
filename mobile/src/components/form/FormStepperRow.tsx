import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '../../theme';
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
}

export function FormStepperRow({
  label,
  value,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  onValueChange,
  disabled,
  format,
}: FormStepperRowProps) {
  const colors = useColors();

  const dec = () => {
    const next = Math.max(min, value - step);
    if (next !== value) onValueChange(next);
  };
  const inc = () => {
    const next = Math.min(max, value + step);
    if (next !== value) onValueChange(next);
  };

  return (
    <FormRow label={label} disabled={disabled}>
      <View style={styles.container}>
        <Text style={[styles.value, { color: colors.foreground }]}>
          {format ? format(value) : String(value)}
        </Text>
        <View
          style={[
            styles.buttons,
            { backgroundColor: colors.muted, borderColor: colors.border },
          ]}
        >
          <Pressable
            onPress={dec}
            disabled={disabled || value <= min}
            style={[styles.btn, styles.btnLeft]}
          >
            <Text
              style={[
                styles.btnText,
                {
                  color: value <= min ? colors.mutedForeground : colors.foreground,
                },
              ]}
            >
              −
            </Text>
          </Pressable>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <Pressable
            onPress={inc}
            disabled={disabled || value >= max}
            style={[styles.btn, styles.btnRight]}
          >
            <Text
              style={[
                styles.btnText,
                {
                  color: value >= max ? colors.mutedForeground : colors.foreground,
                },
              ]}
            >
              ＋
            </Text>
          </Pressable>
        </View>
      </View>
    </FormRow>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  value: {
    fontSize: 16,
    minWidth: 60,
    textAlign: 'right',
  },
  buttons: {
    flexDirection: 'row',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  btn: {
    width: 36,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnLeft: {},
  btnRight: {},
  divider: {
    width: StyleSheet.hairlineWidth,
  },
  btnText: {
    fontSize: 20,
    lineHeight: 22,
    fontWeight: '500',
  },
});
