/**
 * Timestamp Utility
 *
 * 为用户消息添加时间戳前缀，帮助 AI 理解「今天」「昨天」等相对时间词汇
 */

/**
 * 默认时区
 */
const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/**
 * 获取目标时区的星期几（zh-CN short 格式，如"周一"）
 */
function getWeekday(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, weekday: 'short' }).format(date);
}

/**
 * 格式化当前时间戳（含星期）
 * @param timezone IANA 时区名称，默认 Asia/Shanghai
 * @returns 格式化的时间戳，如 "2026/01/31 周五 15:30"
 */
export function formatTimestamp(timezone: string = DEFAULT_TIMEZONE): string {
  try {
    const now = new Date();
    const datePart = now.toLocaleString('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour12: false,
    });
    const timePart = now.toLocaleString('zh-CN', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const weekday = getWeekday(now, timezone);
    return `${datePart} ${weekday} ${timePart}`;
  } catch {
    const now = new Date();
    const datePart = now.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour12: false,
    });
    const timePart = now.toLocaleString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const weekday = getWeekday(now, DEFAULT_TIMEZONE);
    return `${datePart} ${weekday} ${timePart}`;
  }
}

/**
 * 为消息添加时间戳前缀
 * @param message 原始消息
 * @param timezone IANA 时区名称
 * @returns 带时间戳前缀的消息，如 "[2026/01/31 周五 15:30] 你好"
 */
export function addTimestampPrefix(message: string, timezone?: string): string {
  const timestamp = formatTimestamp(timezone);
  return `[${timestamp}] ${message}`;
}
