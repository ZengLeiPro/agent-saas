/**
 * 与 Web `web/src/components/ui/` 语义对齐的移动端 UI 基元集。
 *
 * 约定：
 * 1. 基元只读 theme token（colors / spacing / radius / fontScale / shadows），
 *    组件内不出现字面量色值与 fontSize 数字；
 * 2. 纯映射逻辑（variant / 状态 / 分组圆角）抽在 *Styles.ts 里可单测；
 * 3. 命令式浮层（showTextPrompt / showActionMenu）复用 `src/lib/prompt.ts`
 *    的 handler 注册机制，宿主统一挂在 `PromptHost`。
 */
export { Button, type ButtonProps, type ButtonIcon } from './Button';
export {
  resolveButtonVariant,
  resolveButtonSize,
  isBareVariant,
  BUTTON_DISABLED_OPACITY,
  type ButtonVariant,
  type ButtonSize,
  type ButtonVariantTokens,
  type ButtonSizeTokens,
} from './buttonStyles';

export { Badge, type BadgeProps } from './Badge';
export {
  resolveBadgeVariant,
  resolveBadgeSize,
  type BadgeVariant,
  type BadgeSize,
  type BadgeVariantTokens,
  type BadgeSizeTokens,
} from './badgeStyles';

export {
  StatusBadge,
  StatusDot,
  StatusIcon,
  type StatusBadgeProps,
  type StatusDotProps,
} from './StatusBadge';
export { resolveStatusTone, statusLabel, type RunStatus, type StatusTone } from './statusStyles';

export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  type CardProps,
  type CardSlotProps,
  type CardDensity,
} from './Card';

export { Separator, type SeparatorProps } from './Separator';
export { Skeleton, type SkeletonProps } from './Skeleton';

export { ListRow, ListRowGroup, type ListRowProps, type ListRowGroupProps } from './ListRow';
export {
  resolveListRowPosition,
  resolveListRowShape,
  type ListRowPosition,
  type ListRowShape,
} from './listRowStyles';

export { BottomSheet, type BottomSheetProps, type BottomSheetSnap } from './BottomSheet';
export {
  ActionSheet,
  ActionSheetHost,
  type ActionSheetProps,
  type ActionMenuItem,
  type ActionMenuOptions,
} from './ActionSheet';
export { TextPrompt, type TextPromptProps } from './TextPrompt';
/** 命令式入口：宿主为 PromptHost，见 src/lib/prompt.ts */
export { showTextPrompt, showActionMenu, type TextPromptOptions } from '../../lib/prompt';

export { EmptyState, type EmptyStateProps } from './EmptyState';
export { Chip, type ChipProps } from './Chip';
export { Input, type InputProps } from './Input';
export { useSpinStyle, usePulseStyle } from './motion';
