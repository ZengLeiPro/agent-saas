import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useColors, spacing, radius, fontScale, fontWeight } from '../../theme';
import type { TextPromptOptions } from '../../lib/prompt';

export interface TextPromptProps extends Omit<TextPromptOptions, 'onCancel'> {
  visible: boolean;
  onCancel: () => void;
  testID?: string;
}

/**
 * 受控文本输入对话框。
 *
 * 命令式入口仍是 `src/lib/prompt.ts` 的 `showTextPrompt`（iOS 走原生 Alert.prompt，
 * Android 走 PromptHost）；本组件是 PromptHost 抽出来的可复用外观层，
 * 也可被页面直接受控使用。
 */
export function TextPrompt({
  visible,
  title,
  message,
  defaultValue,
  placeholder,
  confirmText = '确定',
  cancelText = '取消',
  secureTextEntry,
  keyboardType,
  maxLength,
  multiline,
  autoCapitalize = 'sentences',
  extraAction,
  onConfirm,
  onCancel,
  testID = 'text-prompt',
}: TextPromptProps) {
  const colors = useColors();
  const [value, setValue] = useState(defaultValue ?? '');
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!visible) return;
    setValue(defaultValue ?? '');
    const timer = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(timer);
  }, [visible, defaultValue]);

  if (!visible) return null;

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onCancel} statusBarTranslucent>
      <KeyboardAvoidingView
        style={[styles.backdrop, { backgroundColor: colors.overlay }]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
        <View
          testID={testID}
          style={[styles.dialog, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Text style={[styles.title, { color: colors.foreground }]}>{title}</Text>
          {message ? (
            <Text style={[styles.message, { color: colors.mutedForeground }]}>{message}</Text>
          ) : null}
          <TextInput
            ref={inputRef}
            testID={`${testID}-input`}
            value={value}
            onChangeText={setValue}
            placeholder={placeholder}
            placeholderTextColor={colors.mutedForeground}
            secureTextEntry={secureTextEntry}
            keyboardType={keyboardType}
            maxLength={maxLength}
            multiline={multiline}
            autoCapitalize={autoCapitalize}
            autoCorrect={false}
            onSubmitEditing={multiline ? undefined : () => onConfirm(value)}
            returnKeyType="done"
            style={[
              styles.input,
              {
                color: colors.foreground,
                backgroundColor: colors.background,
                borderColor: colors.input,
                minHeight: multiline ? 80 : 40,
                textAlignVertical: multiline ? 'top' : 'center',
              },
            ]}
          />
          <View style={styles.actions}>
            <Pressable
              testID={`${testID}-cancel`}
              accessibilityRole="button"
              accessibilityLabel={cancelText}
              onPress={onCancel}
              style={({ pressed }) => [styles.btn, pressed ? styles.pressed : null]}
            >
              <Text style={[styles.btnText, { color: colors.mutedForeground }]}>{cancelText}</Text>
            </Pressable>
            {extraAction ? (
              <Pressable
                testID={`${testID}-extra`}
                accessibilityRole="button"
                accessibilityLabel={extraAction.label}
                onPress={extraAction.onPress}
                style={({ pressed }) => [styles.btn, pressed ? styles.pressed : null]}
              >
                <Text style={[styles.btnText, { color: colors.foreground }]}>
                  {extraAction.label}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              testID={`${testID}-confirm`}
              accessibilityRole="button"
              accessibilityLabel={confirmText}
              onPress={() => onConfirm(value)}
              style={({ pressed }) => [styles.btn, pressed ? styles.pressed : null]}
            >
              <Text style={[styles.btnText, styles.btnPrimary, { color: colors.primary }]}>
                {confirmText}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing['2xl'],
  },
  dialog: {
    width: '100%',
    maxWidth: 360,
    borderRadius: radius['2xl'],
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.xl,
  },
  title: {
    ...fontScale.lg,
    fontWeight: fontWeight.semibold,
    marginBottom: spacing.xs,
  },
  message: {
    ...fontScale.sm,
    marginBottom: spacing.md,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...fontScale.base,
    marginTop: spacing.xs,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  btn: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  pressed: {
    opacity: 0.6,
  },
  btnText: {
    ...fontScale.base,
  },
  btnPrimary: {
    fontWeight: fontWeight.semibold,
  },
});
