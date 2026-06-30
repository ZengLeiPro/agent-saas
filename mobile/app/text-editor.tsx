import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons, Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useColors, spacing, typography } from '../src/theme';
import { textEditorBridge } from '../src/lib/textEditorBridge';

export default function TextEditorScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const { value: initialValue, title, placeholder } = textEditorBridge.getInitial();
  const [body, setBody] = useState(initialValue);
  const initialRef = useRef(initialValue);
  const isDirty = body !== initialRef.current;

  const handleSave = useCallback(() => {
    textEditorBridge.save(body);
    router.back();
  }, [body, router]);

  const handleClose = useCallback(() => {
    const exit = () => {
      textEditorBridge.cancel();
      router.back();
    };
    if (isDirty) {
      Alert.alert('放弃修改？', '你有未保存的修改，确定要放弃吗？', [
        { text: '继续编辑', style: 'cancel' },
        { text: '放弃', style: 'destructive', onPress: exit },
      ]);
    } else {
      exit();
    }
  }, [isDirty, router]);

  const headerLeft = useCallback(
    () => (
      <TouchableOpacity onPress={handleClose} activeOpacity={0.7}>
        <Ionicons name="close" size={24} color={colors.foreground} />
      </TouchableOpacity>
    ),
    [handleClose, colors.foreground],
  );

  const headerRight = useCallback(
    () => (
      <TouchableOpacity onPress={handleSave} activeOpacity={0.7}>
        <Feather name="check" size={24} color={colors.foreground} />
      </TouchableOpacity>
    ),
    [handleSave, colors.foreground],
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.card },
        content: {
          flex: 1,
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.md,
        },
        textArea: {
          ...typography.body,
          color: colors.foreground,
          fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
          fontSize: 13,
          lineHeight: 20,
          flex: 1,
          textAlignVertical: 'top',
          padding: 0,
        },
      }),
    [colors],
  );

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title, headerLeft, headerRight }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <View style={styles.content}>
          <TextInput
            style={[styles.textArea, { paddingBottom: insets.bottom + spacing.xl }]}
            value={body}
            onChangeText={setBody}
            placeholder={placeholder}
            placeholderTextColor={colors.mutedForeground}
            multiline
            autoFocus
            autoCorrect={false}
            scrollEnabled
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
