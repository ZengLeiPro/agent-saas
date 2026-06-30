import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '../../theme';
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
}

export function FormSegmentedRow<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: FormSegmentedRowProps<T>) {
  const colors = useColors();
  return (
    <FormRow label={label} disabled={disabled} vertical={!label ? false : false}>
      <View
        style={[
          styles.container,
          {
            backgroundColor: colors.muted,
          },
        ]}
      >
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => !disabled && onChange(opt.value)}
              style={[
                styles.segment,
                active
                  ? { backgroundColor: colors.card }
                  : null,
              ]}
            >
              <Text
                style={[
                  styles.segmentText,
                  {
                    color: active ? colors.foreground : colors.mutedForeground,
                    fontWeight: active ? '600' : '400',
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

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    borderRadius: 8,
    padding: 2,
    minWidth: 180,
  },
  segment: {
    flex: 1,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentText: {
    fontSize: 13,
  },
});
