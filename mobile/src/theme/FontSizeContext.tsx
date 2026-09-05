import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { TextStyle } from 'react-native';
import { getPlatform } from '@agent/shared';
import {
  CHAT_FONT_SIZE_SCALE,
  DEFAULT_CHAT_FONT_SIZE_LEVEL,
  normalizeChatFontSizeLevel,
  type ChatFontSizeLevel,
} from '../lib/settings/chatFontSize';
import { typography } from './typography';

// --- Types ---

/**
 * P3-3d：档位由四档（small/default/medium/large）收敛为三档，
 * 与 Web 的二档语义对齐（small ≡ 小、large ≡ 大），额外保留移动端出厂档 default。
 * 档位常量、旧值迁移与 Web 互转都在 `src/lib/settings/chatFontSize.ts`（可单测）。
 */
export type FontSizeLevel = ChatFontSizeLevel;

interface FontSizeContextValue {
  level: FontSizeLevel;
  setLevel: (level: FontSizeLevel) => void;
  scale: number;
}

// --- Constants ---

const SCALE_MAP = CHAT_FONT_SIZE_SCALE;

const FONT_SIZE_KEY = 'chat_font_size';

// --- Context ---

const FontSizeContext = createContext<FontSizeContextValue | null>(null);

export function FontSizeProvider({ children }: { children: React.ReactNode }) {
  const [level, setLevelState] = useState<FontSizeLevel>(DEFAULT_CHAT_FONT_SIZE_LEVEL);

  useEffect(() => {
    void (async () => {
      const stored = await getPlatform().storage.getItem(FONT_SIZE_KEY);
      if (stored === null || stored === undefined) return;
      const normalized = normalizeChatFontSizeLevel(stored);
      setLevelState(normalized);
      // 旧档位（medium）读到后就地迁移，避免下次启动再走一遍归一化。
      if (normalized !== stored) {
        void getPlatform().storage.setItem(FONT_SIZE_KEY, normalized);
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
    return Object.fromEntries(
      Object.entries(typography).map(([key, style]) => [key, scaleStyle(style, scale)]),
    ) as typeof typography;
  }, [scale]);
}
