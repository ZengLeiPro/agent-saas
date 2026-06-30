import React from 'react';
import { StyleSheet, TextInput, type KeyboardTypeOptions, type ReturnKeyTypeOptions } from 'react-native';
import { useColors } from '../../theme';
import { FormRow } from './FormRow';

interface FormTextFieldProps {
  label?: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  returnKeyType?: ReturnKeyTypeOptions;
  disabled?: boolean;
  multiline?: boolean;
  autoFocus?: boolean;
  onSubmitEditing?: () => void;
  rightAccessory?: React.ReactNode;
  required?: boolean;
}

export function FormTextField({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
  autoCapitalize = 'none',
  autoCorrect = false,
  returnKeyType,
  disabled,
  multiline,
  autoFocus,
  onSubmitEditing,
  rightAccessory,
  required,
}: FormTextFieldProps) {
  const colors = useColors();
  return (
    <FormRow label={label} disabled={disabled} rightAccessory={rightAccessory} required={required}>
      <TextInput
        style={[
          styles.input,
          {
            color: disabled ? colors.mutedForeground : colors.foreground,
          },
          label ? styles.inputAligned : null,
          multiline ? styles.inputMultiline : null,
        ]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        returnKeyType={returnKeyType}
        editable={!disabled}
        multiline={multiline}
        autoFocus={autoFocus}
        onSubmitEditing={onSubmitEditing}
        textAlignVertical={multiline ? 'top' : 'center'}
      />
    </FormRow>
  );
}

const styles = StyleSheet.create({
  input: {
    flex: 1,
    fontSize: 16,
    paddingVertical: 0,
    minHeight: 24,
  },
  inputAligned: {
    textAlign: 'right',
  },
  inputMultiline: {
    textAlign: 'left',
    minHeight: 60,
  },
});
