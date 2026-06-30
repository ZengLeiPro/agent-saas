import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { useColors } from './ThemeContext';
import type { ThemeColors } from './colors';

export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (colors: ThemeColors) => T,
): T {
  const colors = useColors();
  return useMemo(() => StyleSheet.create(factory(colors)), [colors]);
}
