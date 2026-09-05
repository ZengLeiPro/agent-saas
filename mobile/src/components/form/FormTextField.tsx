import React from 'react';
import { StyleSheet, type KeyboardTypeOptions, type ReturnKeyTypeOptions } from 'react-native';
import { Input } from '../ui/Input';
import type { ListRowPosition } from '../ui/listRowStyles';
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
  /** 校验失败：文字转 danger（行内输入没有边框可以变色） */
  invalid?: boolean;
  position?: ListRowPosition;
}

/**
 * 行内文本输入：`ui/Input` 的 `bare` 形态嵌进 `FormRow`。
 * 输入框本体的字号/占位色/禁用态全部由 Input 统一提供，本文件不再自带样式档。
 */
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
  invalid,
  position,
}: FormTextFieldProps) {
  return (
    <FormRow
      label={label}
      disabled={disabled}
      rightAccessory={rightAccessory}
      required={required}
      position={position}
    >
      <Input
        style={styles.input}
        variant="bare"
        align={label && !multiline ? 'right' : 'left'}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        returnKeyType={returnKeyType}
        editable={!disabled}
        multiline={multiline}
        autoFocus={autoFocus}
        invalid={invalid}
        onSubmitEditing={onSubmitEditing}
      />
    </FormRow>
  );
}

const styles = StyleSheet.create({
  input: {
    flex: 1,
  },
});
