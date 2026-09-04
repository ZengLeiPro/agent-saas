/**
 * 运行状态（running / success / error / cancelled / pending）→ 颜色 + 文案 的纯映射。
 *
 * 与 Web 的状态语义一致：
 *   running  → info（蓝，图标旋转）
 *   success  → success（绿）
 *   error    → danger（红）
 *   cancelled/pending → muted（灰，不抢视线）
 * 图标本体由 `src/lib/icons.ts` 的 StatusIcons 提供，本模块保持无 UI 依赖以便单测。
 */
import type { BadgeVariant } from './badgeStyles';
import type { ThemeColors } from '../../theme';

export type RunStatus = 'running' | 'success' | 'error' | 'cancelled' | 'pending';

export interface StatusTone {
  /** 实心色：圆点 / 图标描边 */
  tint: string;
  /** 浅底：徽章背景 */
  subtle: string;
  /** 浅底之上的文字色 */
  ink: string;
  /** 默认中文文案 */
  label: string;
  /** 图标是否需要持续旋转 */
  spinning: boolean;
  /** 对应的 Badge 变体（保证徽章与圆点用同一族颜色） */
  badgeVariant: BadgeVariant;
}

const LABELS: Record<RunStatus, string> = {
  running: '运行中',
  success: '成功',
  error: '失败',
  cancelled: '已取消',
  pending: '等待中',
};

export function resolveStatusTone(status: RunStatus, colors: ThemeColors): StatusTone {
  const label = LABELS[status];
  switch (status) {
    case 'running':
      return {
        tint: colors.infoFamily.DEFAULT,
        subtle: colors.infoFamily.subtle,
        ink: colors.infoFamily.ink,
        label,
        spinning: true,
        badgeVariant: 'info',
      };
    case 'success':
      return {
        tint: colors.successFamily.DEFAULT,
        subtle: colors.successFamily.subtle,
        ink: colors.successFamily.ink,
        label,
        spinning: false,
        badgeVariant: 'success',
      };
    case 'error':
      return {
        tint: colors.dangerFamily.DEFAULT,
        subtle: colors.dangerFamily.subtle,
        ink: colors.dangerFamily.ink,
        label,
        spinning: false,
        badgeVariant: 'danger',
      };
    case 'cancelled':
    case 'pending':
      return {
        tint: colors.mutedForeground,
        subtle: colors.muted,
        ink: colors.mutedForeground,
        label,
        spinning: false,
        badgeVariant: 'secondary',
      };
  }
}

export function statusLabel(status: RunStatus): string {
  return LABELS[status];
}
