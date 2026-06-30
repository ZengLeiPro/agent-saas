import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { type ThemeColors, lightColors, darkColors } from './colors';

interface ThemeContextValue {
  scheme: 'light' | 'dark';
  colors: ThemeColors;
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const scheme = (systemScheme === 'dark' ? 'dark' : 'light') as 'light' | 'dark';
  const value = useMemo<ThemeContextValue>(() => ({
    scheme,
    colors: scheme === 'dark' ? darkColors : lightColors,
    isDark: scheme === 'dark',
  }), [scheme]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

export function useColors(): ThemeColors {
  return useTheme().colors;
}
