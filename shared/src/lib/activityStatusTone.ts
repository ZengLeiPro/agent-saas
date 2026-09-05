/**
 * 活动状态语气与耗时格式化（纯函数，无 DOM / React 依赖）。
 *
 * 与 `web/src/components/activityStatusStyles.ts` 同一套语义：Web 把语气映射成
 * Tailwind class，Mobile 把语气映射成 theme token，**语气本身的判定必须同源**，
 * 否则两端「同一条会话」的色彩层级会各自演化。本模块只出语气与文案，不出样式。
 */
import type { PresentationTone } from './presentation/types';

export type ActivityStatusTone =
  'active' | 'pending' | 'success' | 'warning' | 'danger' | 'neutral';

/** 呈现块语气（业务契约）→ 活动状态语气（渲染层色板）。与 Web TONE_MAP 一致。 */
export const PRESENTATION_TONE_TO_ACTIVITY: Readonly<Record<PresentationTone, ActivityStatusTone>> =
  Object.freeze({
    neutral: 'neutral',
    info: 'active',
    success: 'success',
    warn: 'warning',
    danger: 'danger',
    muted: 'pending',
  });

/**
 * 耗时格式化：1s 以内给毫秒，1 分钟以内给秒，1 小时以内给分钟，其余给小时。
 * 非法值（NaN / 负数 / 非数字）返回 null——调用方据此隐藏耗时位，而不是显示 "NaNms"。
 */
export function formatActivityDuration(ms?: number): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;

  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(ms < 10_000 ? 1 : 0)}s`;

  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0).replace(/\.0$/, '')}m`;

  const hours = minutes / 60;
  return `${hours.toFixed(hours < 10 ? 1 : 0).replace(/\.0$/, '')}h`;
}
