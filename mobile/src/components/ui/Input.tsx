import React, { useState } from 'react';
import {
  StyleSheet,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type ReturnKeyTypeOptions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useColors, spacing, radius, fontScale } from '../../theme';

export interface InputProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: KeyboardTypeOptions;
  returnKeyType?: ReturnKeyTypeOptions;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  editable?: boolean;
  multiline?: boolean;
  /** 校验失败：边框转 danger */
  invalid?: boolean;
  /**
   * 形态：`boxed`（默认）为独立描边输入框；
   * `bare` 去掉描边/底色/内边距，供 `form/FormTextField` 这类「行内输入」内嵌到列表行里。
   */
  variant?: 'boxed' | 'bare';
  /** 文本对齐：设置页样式的行内输入通常右对齐 */
  align?: 'left' | 'right';
  onSubmitEditing?: () => void;
  /** 右侧内联控件（如「获取验证码」按钮） */
  trailing?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}

/**
 * 单行输入框：对齐 Web `web/src/components/ui/input.tsx`
 * ——卡片底 + hairline 边框，聚焦时边框换成 `colors.ring`（RN 没有 outline，改用边框色表达 focus ring）。
 */
export function Input({
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
  returnKeyType,
  autoCapitalize = 'none',
  autoCorrect = false,
  autoFocus,
  maxLength,
  editable = true,
  multiline,
  invalid = false,
  variant = 'boxed',
  align = 'left',
  onSubmitEditing,
  trailing,
  style,
  testID,
  accessibilityLabel,
}: InputProps) {
  const colors = useColors();
  const [focused, setFocused] = useState(false);
  const borderColor = invalid ? colors.destructive : focused ? colors.ring : colors.input;
  const bare = variant === 'bare';

  return (
    <View
      style={[
        styles.wrap,
        bare ? styles.wrapBare : { backgroundColor: colors.card, borderColor },
        editable ? null : styles.disabled,
        style,
      ]}
    >
      <TextInput
        testID={testID}
        accessibilityLabel={accessibilityLabel}
        style={[
          styles.input,
          // bare 形态没有边框可以变色，校验失败改用文字色表达
          { color: bare && invalid ? colors.destructive : colors.foreground, textAlign: align },
          bare ? styles.inputBare : null,
          multiline ? styles.inputMultiline : null,
        ]}
        textAlignVertical={multiline ? 'top' : 'center'}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        returnKeyType={returnKeyType}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        autoFocus={autoFocus}
        maxLength={maxLength}
        editable={editable}
        multiline={multiline}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={onSubmitEditing}
      />
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  wrapBare: {
    minHeight: 0,
    borderWidth: 0,
    paddingHorizontal: 0,
  },
  input: {
    flex: 1,
    paddingVertical: spacing.sm,
    ...fontScale.base,
  },
  inputBare: {
    paddingVertical: 0,
    minHeight: 24,
  },
  inputMultiline: {
    minHeight: 60,
  },
  disabled: {
    opacity: 0.5,
  },
});
