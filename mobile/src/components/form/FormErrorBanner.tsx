import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '../../theme';

interface FormErrorBannerProps {
  message: string;
}

export function FormErrorBanner({ message }: FormErrorBannerProps) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.banner,
        { backgroundColor: colors.errorBg, borderColor: colors.destructive },
      ]}
    >
      <Text style={[styles.text, { color: colors.destructive }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: 16,
    marginBottom: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  text: {
    fontSize: 14,
    lineHeight: 20,
  },
});
