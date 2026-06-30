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
import { useColors } from '../../theme';
import { registerPromptHandler, type TextPromptOptions } from '../../lib/prompt';

export function PromptHost() {
  const colors = useColors();
  const [opts, setOpts] = useState<TextPromptOptions | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    registerPromptHandler((next) => {
      setOpts(next);
      setValue(next.defaultValue ?? '');
      setTimeout(() => inputRef.current?.focus(), 80);
    });
    return () => registerPromptHandler(null);
  }, []);

  if (!opts) return null;

  const handleCancel = () => {
    const o = opts;
    setOpts(null);
    o.onCancel?.();
  };

  const handleConfirm = () => {
    const o = opts;
    setOpts(null);
    o.onConfirm(value);
  };

  return (
    <Modal
      transparent
      animationType="fade"
      visible={!!opts}
      onRequestClose={handleCancel}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={[styles.backdrop, { backgroundColor: colors.overlay }]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={handleCancel} />
        <View
          style={[
            styles.dialog,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.title, { color: colors.foreground }]}>{opts.title}</Text>
          {opts.message ? (
            <Text style={[styles.message, { color: colors.mutedForeground }]}>{opts.message}</Text>
          ) : null}
          <TextInput
            ref={inputRef}
            value={value}
            onChangeText={setValue}
            placeholder={opts.placeholder}
            placeholderTextColor={colors.mutedForeground}
            secureTextEntry={opts.secureTextEntry}
            keyboardType={opts.keyboardType}
            maxLength={opts.maxLength}
            multiline={opts.multiline}
            autoCapitalize={opts.autoCapitalize ?? 'sentences'}
            autoCorrect={false}
            onSubmitEditing={opts.multiline ? undefined : handleConfirm}
            returnKeyType="done"
            style={[
              styles.input,
              {
                color: colors.foreground,
                backgroundColor: colors.background,
                borderColor: colors.border,
                minHeight: opts.multiline ? 80 : 40,
                textAlignVertical: opts.multiline ? 'top' : 'center',
              },
            ]}
          />
          <View style={styles.actions}>
            <Pressable
              onPress={handleCancel}
              style={({ pressed }) => [styles.btn, pressed && { opacity: 0.6 }]}
            >
              <Text style={[styles.btnText, { color: colors.mutedForeground }]}>
                {opts.cancelText ?? '取消'}
              </Text>
            </Pressable>
            {opts.extraAction ? (
              <Pressable
                onPress={() => {
                  const action = opts.extraAction!;
                  setOpts(null);
                  action.onPress();
                }}
                style={({ pressed }) => [styles.btn, pressed && { opacity: 0.6 }]}
              >
                <Text style={[styles.btnText, { color: colors.foreground }]}>
                  {opts.extraAction.label}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={handleConfirm}
              style={({ pressed }) => [styles.btn, pressed && { opacity: 0.6 }]}
            >
              <Text style={[styles.btnText, styles.btnTextPrimary, { color: colors.primary }]}>
                {opts.confirmText ?? '确定'}
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
    padding: 24,
  },
  dialog: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 6,
  },
  message: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    marginTop: 4,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
    gap: 8,
  },
  btn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  btnText: {
    fontSize: 16,
  },
  btnTextPrimary: {
    fontWeight: '600',
  },
});
