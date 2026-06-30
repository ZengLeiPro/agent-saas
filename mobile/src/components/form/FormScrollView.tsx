import React from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useColors } from '../../theme';

interface FormScrollViewProps {
  children: React.ReactNode;
  contentBottomInset?: number;
}

export function FormScrollView({ children, contentBottomInset = 32 }: FormScrollViewProps) {
  const colors = useColors();
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.content, { paddingBottom: contentBottomInset }]}
        keyboardShouldPersistTaps="handled"
      >
        <View>{children}</View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: 16,
  },
});
