import React from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useColors, spacing } from '../../theme';

interface FormScrollViewProps {
  children: React.ReactNode;
  contentBottomInset?: number;
  testID?: string;
}

export function FormScrollView({
  children,
  contentBottomInset = spacing['3xl'],
  testID,
}: FormScrollViewProps) {
  const colors = useColors();
  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        testID={testID}
        style={styles.flex}
        contentContainerStyle={[styles.content, { paddingBottom: contentBottomInset }]}
        keyboardShouldPersistTaps="handled"
      >
        <View>{children}</View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  content: {
    paddingTop: spacing.lg,
  },
});
