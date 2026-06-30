import React from 'react';
import { Switch } from 'react-native';
import { useColors } from '../../theme';
import { FormRow } from './FormRow';

interface FormSwitchRowProps {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}

export function FormSwitchRow({ label, value, onValueChange, disabled }: FormSwitchRowProps) {
  const colors = useColors();
  return (
    <FormRow label={label} disabled={disabled}>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: colors.muted, true: colors.success }}
        thumbColor={colors.card}
        ios_backgroundColor={colors.muted}
      />
    </FormRow>
  );
}
