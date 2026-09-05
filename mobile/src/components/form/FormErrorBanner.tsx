import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors, spacing, radius, fontScale } from '../../theme';

interface FormErrorBannerProps {
  message: string;
}

/** 表单顶部错误条：danger 语义四支（subtle 底 + DEFAULT 描边 + ink 文字）。 */
export function FormErrorBanner({ message }: FormErrorBannerProps) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.banner,
        {
          backgroundColor: colors.dangerFamily.subtle,
          borderColor: colors.dangerFamily.DEFAULT,
        },
      ]}
    >
      <Text style={[styles.text, { color: colors.dangerFamily.ink }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  text: {
    ...fontScale.sm,
  },
});
