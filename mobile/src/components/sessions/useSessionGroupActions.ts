/**
 * 会话分组的交互编排 —— 对齐 Web `MobileSessionList` 里的四个分组对话框
 * （添加到分组 / 新建分组 / 重命名分组 / 删除分组），文案与 Web Dialog 一致。
 *
 * 从 `(tabs)/chat/index.tsx` 抽出：屏幕只负责把它的 sheet 渲染出来。
 */
import { useCallback, useMemo, useState } from 'react';
import type { ChatSessionIndexItem, SessionGroup } from '@agent/shared';
import { getSortedGroupItems, useGroups } from '@agent/shared';
import { showActionMenu, showTextPrompt } from '../ui';
import { hapticSuccess, hapticWarning } from '../../lib/haptics';

export type GroupsHook = ReturnType<typeof useGroups>;

export interface UseSessionGroupActionsOptions {
  groupsHook: GroupsHook;
  sessions: readonly ChatSessionIndexItem[];
  /** 一次分组操作完成后的收尾（列表页用来退出多选模式） */
  onCompleted?: () => void;
}

export interface SessionGroupActions {
  /** 已按用户排序偏好排好序的全部分组，供选择器渲染 */
  allGroups: SessionGroup[];
  hasManualGroups: boolean;
  /** 「添加到分组」面板是否可见 */
  pickerVisible: boolean;
  closePicker: () => void;
  /** 打开「添加到分组」面板，携带要归类的会话 id 集合 */
  openPicker: (sessionIds: string[]) => void;
  addToGroup: (groupKey: string) => void;
  /** 面板里的「新建分组」：先收起面板但保留待归类会话，再弹输入框 */
  promptCreateGroupForPending: () => void;
  /** FAB 次级按钮：直接新建空分组 */
  promptCreateEmptyGroup: () => void;
  promptRenameGroup: (group: SessionGroup) => void;
  confirmDeleteGroup: (group: SessionGroup) => void;
}

export function useSessionGroupActions({
  groupsHook,
  sessions,
  onCompleted,
}: UseSessionGroupActionsOptions): SessionGroupActions {
  const [pendingSessionIds, setPendingSessionIds] = useState<string[] | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);

  const allGroups = useMemo<SessionGroup[]>(
    () =>
      getSortedGroupItems(groupsHook.groups, groupsHook.sorting, sessions).map((item) => ({
        groupKey: item.id,
        name: item.name,
        kind: item.kind,
        children: [],
        latestUpdatedAt: item.updatedAt,
        count: item.count,
        isRunning: false,
      })),
    [groupsHook.groups, groupsHook.sorting, sessions],
  );

  const hasManualGroups = useMemo(
    () => groupsHook.groups.some((group) => group.kind === 'manual'),
    [groupsHook.groups],
  );

  const openPicker = useCallback((sessionIds: string[]) => {
    if (sessionIds.length === 0) return;
    setPendingSessionIds(sessionIds);
    setPickerVisible(true);
  }, []);

  const closePicker = useCallback(() => {
    setPickerVisible(false);
    setPendingSessionIds(null);
  }, []);

  const addToGroup = useCallback(
    (groupKey: string) => {
      const ids = pendingSessionIds;
      closePicker();
      if (!ids || ids.length === 0) return;
      void groupsHook.addSessionsToGroup(groupKey, ids).then(() => {
        hapticSuccess();
        onCompleted?.();
      });
    },
    [pendingSessionIds, groupsHook, closePicker, onCompleted],
  );

  // 输入框弹出前只收起面板，待归类会话保留到确认或取消为止。
  const promptCreateGroupForPending = useCallback(() => {
    const ids = pendingSessionIds ?? [];
    setPickerVisible(false);
    showTextPrompt({
      title: '新建分组',
      message: '输入新的分组名称',
      placeholder: '分组名称',
      onCancel: () => setPendingSessionIds(null),
      onConfirm: (name) => {
        setPendingSessionIds(null);
        const trimmed = name.trim();
        if (!trimmed) return;
        void groupsHook.createGroup(trimmed, ids).then(() => {
          hapticSuccess();
          onCompleted?.();
        });
      },
    });
  }, [pendingSessionIds, groupsHook, onCompleted]);

  const promptCreateEmptyGroup = useCallback(() => {
    showTextPrompt({
      title: '新建分组',
      message: '输入新的分组名称',
      placeholder: '分组名称',
      onConfirm: (name) => {
        const trimmed = name.trim();
        if (trimmed) void groupsHook.createGroup(trimmed, []).then(() => hapticSuccess());
      },
    });
  }, [groupsHook]);

  const promptRenameGroup = useCallback(
    (group: SessionGroup) => {
      showTextPrompt({
        title: '重命名分组',
        message:
          group.kind === 'cron'
            ? '输入新的分组名称。注意：此分组关联定时任务，下次执行时名称可能被自动覆盖。'
            : '输入新的分组名称',
        placeholder: '分组名称',
        defaultValue: group.name,
        onConfirm: (name) => {
          const trimmed = name.trim();
          if (trimmed) void groupsHook.renameGroup(group.groupKey, trimmed);
        },
      });
    },
    [groupsHook],
  );

  const confirmDeleteGroup = useCallback(
    (group: SessionGroup) => {
      hapticWarning();
      showActionMenu({
        title: '删除分组',
        message:
          '确定要删除这个分组吗？分组内的会话不会被删除，将变为未分组状态。' +
          (group.kind === 'cron' ? '注意：此分组关联定时任务，下次任务执行时会自动重新创建。' : ''),
        actions: [
          {
            label: '删除',
            destructive: true,
            onPress: () => {
              void groupsHook.deleteGroup(group.groupKey);
            },
          },
        ],
      });
    },
    [groupsHook],
  );

  return {
    allGroups,
    hasManualGroups,
    pickerVisible,
    closePicker,
    openPicker,
    addToGroup,
    promptCreateGroupForPending,
    promptCreateEmptyGroup,
    promptRenameGroup,
    confirmDeleteGroup,
  };
}
