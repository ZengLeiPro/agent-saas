import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { spacing, typography, useColors } from '../theme';

interface BackButtonProps {
  label?: string;
  onPress?: () => void;
}

export function BackButton({ label, onPress }: BackButtonProps) {
  const colors = useColors();
  const router = useRouter();

  return (
    <TouchableOpacity
      onPress={onPress ?? (() => router.back())}
      activeOpacity={0.7}
      style={{ padding: 4, flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}
    >
      <Feather name="chevron-left" size={22} color={colors.foreground} />
      {label ? <Text style={{ ...typography.body, color: colors.foreground }}>{label}</Text> : null}
    </TouchableOpacity>
  );
}
