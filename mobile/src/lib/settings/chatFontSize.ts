/**
 * 会话字号档位 —— 与 Web `useChatFontSize` / `FontSizeToggle` 的口径对齐。
 *
 * 对齐决策（P3-3d）：
 * - Web 只有二档：小(14px) / 大(16px)，存 `agentChat.chatFontSize` = 'small' | 'large'；
 * - 移动端此前是四档（small / default / medium / large），比 Web 多两档且没有语义锚点；
 * - 本次收敛为 **三档**：`small` ≡ Web「小」，`large` ≡ Web「大」，
 *   另保留移动端独有的 `default`（系统默认字号，1.0 倍）作为出厂档——
 *   手机上「小」相对系统字号偏小，去掉默认档会让老用户被迫二选一。
 * - 旧值迁移：`medium`（1.2 倍）归入 `large`，两者同属「放大」语义；
 *   未知/缺失值一律回落 `default`（出厂档，fail safe）。
 */

export const CHAT_FONT_SIZE_LEVELS = ['small', 'default', 'large'] as const;

export type ChatFontSizeLevel = (typeof CHAT_FONT_SIZE_LEVELS)[number];

/** 相对基准字号的缩放倍率（`small` / `large` 沿用移动端既有取值）。 */
export const CHAT_FONT_SIZE_SCALE: Record<ChatFontSizeLevel, number> = {
  small: 0.85,
  default: 1.0,
  large: 1.35,
};

/** 档位中文标签（与 Web 的「小 / 大」同名，`默认` 是移动端独有档）。 */
export const CHAT_FONT_SIZE_LABELS: Record<ChatFontSizeLevel, string> = {
  small: '小',
  default: '默认',
  large: '大',
};

export const DEFAULT_CHAT_FONT_SIZE_LEVEL: ChatFontSizeLevel = 'default';

/** 已下线的旧档位 → 新档位（持久化过的老值必须能读回来）。 */
const LEGACY_LEVEL_ALIASES: Record<string, ChatFontSizeLevel> = {
  medium: 'large',
};

export function isChatFontSizeLevel(value: unknown): value is ChatFontSizeLevel {
  return typeof value === 'string' && (CHAT_FONT_SIZE_LEVELS as readonly string[]).includes(value);
}

/** 读取持久化值：识别当前档位、迁移旧档位，其余回落出厂档。 */
export function normalizeChatFontSizeLevel(stored: string | null | undefined): ChatFontSizeLevel {
  if (isChatFontSizeLevel(stored)) return stored;
  if (typeof stored === 'string' && LEGACY_LEVEL_ALIASES[stored]) {
    return LEGACY_LEVEL_ALIASES[stored];
  }
  return DEFAULT_CHAT_FONT_SIZE_LEVEL;
}

export function chatFontSizeScale(level: ChatFontSizeLevel): number {
  return CHAT_FONT_SIZE_SCALE[level];
}

/**
 * 投影到 Web 的二档语义（Web 只认 'small' | 'large'）。
 * 移动端独有的 `default` 归入 Web 的「小」——Web 的「小」是它的出厂档。
 */
export function toWebChatFontSize(level: ChatFontSizeLevel): 'small' | 'large' {
  return level === 'large' ? 'large' : 'small';
}

/** 从 Web 二档反投影：'large' → `large`，其余 → `small`。 */
export function fromWebChatFontSize(value: string | null | undefined): ChatFontSizeLevel {
  return value === 'large' ? 'large' : 'small';
}
