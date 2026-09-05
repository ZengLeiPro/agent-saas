/**
 * 活动状态语气 → 主题 token 的纯映射。
 *
 * 语气本身由 `@agent/shared` 的 `ActivityStatusTone` 判定（与 Web 同源），
 * 本模块只负责「语气落到哪三支颜色」——Web 落到 Tailwind class，Mobile 落到
 * theme token。业务块一律经由这里取色，不得写字面量色值。
 */
import type { ActivityStatusTone, PresentationTone } from '@agent/shared';
import { PRESENTATION_TONE_TO_ACTIVITY } from '@agent/shared';
import type { ThemeColors } from '../../../theme';

export interface ActivityToneTokens {
  /** 实心色：图标、左侧强调条、圆点 */
  tint: string;
  /** 浅底：横幅 / 告警块背景 */
  subtle: string;
  /** 浅底之上的文字色 */
  ink: string;
}

/**
 * active 走 info 族（蓝）而不是品牌主色：品牌蓝在移动端只留给主 CTA 与选中态，
 * 会话流里的「进行中」若也用品牌蓝，一屏三处蓝会把 CTA 的唯一性稀释掉。
 */
export function resolveActivityToneTokens(
  tone: ActivityStatusTone,
  colors: ThemeColors,
): ActivityToneTokens {
  switch (tone) {
    case 'active':
      return {
        tint: colors.infoFamily.DEFAULT,
        subtle: colors.infoFamily.subtle,
        ink: colors.infoFamily.ink,
      };
    case 'success':
      return {
        tint: colors.successFamily.DEFAULT,
        subtle: colors.successFamily.subtle,
        ink: colors.successFamily.ink,
      };
    case 'warning':
      return {
        tint: colors.warningFamily.DEFAULT,
        subtle: colors.warningFamily.subtle,
        ink: colors.warningFamily.ink,
      };
    case 'danger':
      return {
        tint: colors.dangerFamily.DEFAULT,
        subtle: colors.dangerFamily.subtle,
        ink: colors.dangerFamily.ink,
      };
    case 'pending':
    case 'neutral':
      return { tint: colors.mutedForeground, subtle: colors.muted, ink: colors.mutedForeground };
  }
}

/** 呈现块语气（业务契约）→ 主题 token。经由 shared 的映射表转一次，保证与 Web 同一张表。 */
export function resolvePresentationToneTokens(
  tone: PresentationTone,
  colors: ThemeColors,
): ActivityToneTokens {
  return resolveActivityToneTokens(PRESENTATION_TONE_TO_ACTIVITY[tone], colors);
}

/** Badge 变体：徽章与圆点必须同族取色，避免同一条状态两处不同色。 */
export function toneBadgeVariant(
  tone: ActivityStatusTone,
): 'success' | 'warning' | 'danger' | 'info' | 'secondary' {
  switch (tone) {
    case 'active':
      return 'info';
    case 'success':
      return 'success';
    case 'warning':
      return 'warning';
    case 'danger':
      return 'danger';
    case 'pending':
    case 'neutral':
      return 'secondary';
  }
}
