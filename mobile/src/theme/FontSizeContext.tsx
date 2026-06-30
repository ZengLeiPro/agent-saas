import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { TextStyle } from 'react-native';
import { getPlatform } from '@agent/shared';
import { typography } from './typography';

// --- Types ---

export type FontSizeLevel = 'small' | 'default' | 'medium' | 'large';

interface FontSizeContextValue {
  level: FontSizeLevel;
  setLevel: (level: FontSizeLevel) => void;
  scale: number;
}

// --- Constants ---

const SCALE_MAP: Record<FontSizeLevel, number> = {
  small: 0.85,
  default: 1.0,
  medium: 1.2,
  large: 1.35,
};

const FONT_SIZE_KEY = 'chat_font_size';
const VALID_LEVELS = new Set<string>(Object.keys(SCALE_MAP));

// --- Context ---

const FontSizeContext = createContext<FontSizeContextValue | null>(null);

export function FontSizeProvider({ children }: { children: React.ReactNode }) {
  const [level, setLevelState] = useState<FontSizeLevel>('default');

  useEffect(() => {
    void (async () => {
      const stored = await getPlatform().storage.getItem(FONT_SIZE_KEY);
      if (stored && VALID_LEVELS.has(stored)) {
        setLevelState(stored as FontSizeLevel);
      }
    })();
  }, []);

  const setLevel = useCallback((next: FontSizeLevel) => {
    setLevelState(next);
    void getPlatform().storage.setItem(FONT_SIZE_KEY, next);
  }, []);

  const value = useMemo<FontSizeContextValue>(() => ({
    level,
    setLevel,
    scale: SCALE_MAP[level],
  }), [level, setLevel]);

  return (
    <FontSizeContext.Provider value={value}>
      {children}
    </FontSizeContext.Provider>
  );
}

// --- Hooks ---

export function useFontSize(): FontSizeContextValue {
  const ctx = useContext(FontSizeContext);
  if (!ctx) throw new Error('useFontSize must be used within FontSizeProvider');
  return ctx;
}

function scaleStyle(style: TextStyle, scale: number): TextStyle {
  return {
    ...style,
    fontSize: Math.round(style.fontSize! * scale),
    lineHeight: Math.round(style.lineHeight! * scale),
  };
}

export function useChatTypography(): typeof typography {
  const { scale } = useFontSize();
  return useMemo(() => {
    if (scale === 1) return typography;
    return {
      title: scaleStyle(typography.title, scale),
      subtitle: scaleStyle(typography.subtitle, scale),
      body: scaleStyle(typography.body, scale),
      bodySmall: scaleStyle(typography.bodySmall, scale),
      caption: scaleStyle(typography.caption, scale),
      mono: scaleStyle(typography.mono, scale),
    };
  }, [scale]);
}
