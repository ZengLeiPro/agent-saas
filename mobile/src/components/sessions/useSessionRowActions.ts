/**
 * 会话行滑动动作集 —— 对齐 Web `MobileSessionList` 的 `renderSessionRow`：
 * 分组 / 重命名 / AI 命名 / 移出（仅分组内）/ 删除。
 *
 * 颜色一律取 `colors.actions.*`，宽度与阈值由 `SwipeableRow` 统一按
 * `lib/swipeMotion.ts` 的 72 / 0.4 参数处理。
 */
import { useCallback, useMemo } from 'react';
import type { ChatSessionIndexItem } from '@agent/shared';
import type { SwipeAction } from '../SwipeableRow';
import { showTextPrompt } from '../ui';
import { hapticLight } from '../../lib/haptics';
import { useColors } from '../../theme';

export interface UseSessionRowActionsOptions {
  /** 只读分组（管理员「全部用户」视图）：隐藏「分组」动作 */
  readOnlyGroups: boolean;
  /** 行位于分组详情内：追加「移出」动作 */
  inGroup?: boolean;
  onOpenGroupPicker: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onAutoTitle: (sessionId: string) => void;
  onRemoveFromGroup?: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
}

export function useSessionRowActions(options: UseSessionRowActionsOptions) {
  const colors = useColors();
  const {
    readOnlyGroups,
    inGroup = false,
    onOpenGroupPicker,
    onRename,
    onAutoTitle,
    onRemoveFromGroup,
    onDelete,
  } = options;

  const actionColors = useMemo(() => colors.actions, [colors]);

  return useCallback(
    (session: ChatSessionIndexItem): SwipeAction[] => {
      const actions: SwipeAction[] = [];
      if (!readOnlyGroups) {
        actions.push({
          key: 'group',
          label: '分组',
          backgroundColor: actionColors.organize,
          color: actionColors.onAction,
          onPress: () => {
            hapticLight();
            onOpenGroupPicker(session.id);
          },
        });
      }
      actions.push({
        key: 'rename',
        label: '重命名',
        backgroundColor: actionColors.edit,
        color: actionColors.onAction,
        onPress: () => {
          hapticLight();
          showTextPrompt({
            title: '重命名',
            defaultValue: session.title || '',
            extraAction: { label: '自动', onPress: () => onAutoTitle(session.id) },
            onConfirm: (newTitle) => {
              const trimmed = newTitle.trim();
              if (trimmed) onRename(session.id, trimmed);
            },
          });
        },
      });
      actions.push({
        key: 'autoTitle',
        label: 'AI命名',
        backgroundColor: actionColors.edit,
        color: actionColors.onAction,
        onPress: () => {
          hapticLight();
          onAutoTitle(session.id);
        },
      });
      if (inGroup && !readOnlyGroups && onRemoveFromGroup) {
        actions.push({
          key: 'ungroup',
          label: '移出',
          backgroundColor: actionColors.organize,
          color: actionColors.onAction,
          onPress: () => {
            hapticLight();
            onRemoveFromGroup(session.id);
          },
        });
      }
      actions.push({
        key: 'delete',
        label: '删除',
        backgroundColor: actionColors.destructive,
        color: actionColors.onAction,
        onPress: () => onDelete(session.id),
      });
      return actions;
    },
    [
      actionColors,
      readOnlyGroups,
      inGroup,
      onOpenGroupPicker,
      onRename,
      onAutoTitle,
      onRemoveFromGroup,
      onDelete,
    ],
  );
}
