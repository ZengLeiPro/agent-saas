/** P3-3d：会话字号三档收敛与 Web 二档互转的纯函数测试。 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_FONT_SIZE_LABELS,
  CHAT_FONT_SIZE_LEVELS,
  CHAT_FONT_SIZE_SCALE,
  DEFAULT_CHAT_FONT_SIZE_LEVEL,
  chatFontSizeScale,
  fromWebChatFontSize,
  isChatFontSizeLevel,
  normalizeChatFontSizeLevel,
  toWebChatFontSize,
} from './chatFontSize';

describe('会话字号档位', () => {
  it('收敛为三档且按由小到大排列', () => {
    expect([...CHAT_FONT_SIZE_LEVELS]).toEqual(['small', 'default', 'large']);
    const scales = CHAT_FONT_SIZE_LEVELS.map(chatFontSizeScale);
    expect(scales).toEqual([...scales].sort((a, b) => a - b));
    expect(CHAT_FONT_SIZE_SCALE.default).toBe(1);
  });

  it('每档都有中文标签，且与 Web 的「小 / 大」同名', () => {
    for (const level of CHAT_FONT_SIZE_LEVELS) {
      expect(CHAT_FONT_SIZE_LABELS[level].length).toBeGreaterThan(0);
    }
    expect(CHAT_FONT_SIZE_LABELS.small).toBe('小');
    expect(CHAT_FONT_SIZE_LABELS.large).toBe('大');
  });

  it('isChatFontSizeLevel 只认当前三档', () => {
    expect(isChatFontSizeLevel('small')).toBe(true);
    expect(isChatFontSizeLevel('large')).toBe(true);
    expect(isChatFontSizeLevel('medium')).toBe(false);
    expect(isChatFontSizeLevel(null)).toBe(false);
    expect(isChatFontSizeLevel(1)).toBe(false);
  });

  it('旧档位 medium 迁移到 large，未知值回落出厂档', () => {
    expect(normalizeChatFontSizeLevel('medium')).toBe('large');
    expect(normalizeChatFontSizeLevel('small')).toBe('small');
    expect(normalizeChatFontSizeLevel('default')).toBe('default');
    expect(normalizeChatFontSizeLevel('large')).toBe('large');
    expect(normalizeChatFontSizeLevel(null)).toBe(DEFAULT_CHAT_FONT_SIZE_LEVEL);
    expect(normalizeChatFontSizeLevel(undefined)).toBe('default');
    expect(normalizeChatFontSizeLevel('huge')).toBe('default');
  });

  it('与 Web 二档互转：default 归入 Web 的「小」', () => {
    expect(toWebChatFontSize('small')).toBe('small');
    expect(toWebChatFontSize('default')).toBe('small');
    expect(toWebChatFontSize('large')).toBe('large');
    expect(fromWebChatFontSize('large')).toBe('large');
    expect(fromWebChatFontSize('small')).toBe('small');
    expect(fromWebChatFontSize(null)).toBe('small');
    // large 档在两端可无损往返
    expect(fromWebChatFontSize(toWebChatFontSize('large'))).toBe('large');
  });
});
