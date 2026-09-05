/**
 * 文件多选与删除 —— `/files` 与 `/files/browse` 共用。
 *
 * 二次确认走 `ui/ActionSheet`（`showActionMenu` 的底部动作面板），
 * 危险动作红字，与 Web 删除对话框同一文案（见 `lib/fileDeletePlan.ts`）。
 */
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { authFetch, type FileEntry } from '@agent/shared';
import { showActionMenu } from '../lib/prompt';
import { hapticLight } from '../lib/haptics';
import {
  buildFileDeletePlan,
  buildFileDeleteUrl,
  summarizeDeleteResult,
} from '../lib/fileDeletePlan';

export interface UseFileSelectionOptions {
  owner?: string;
  root?: boolean;
  /** 删除成功后刷新列表 */
  onDeleted: () => Promise<void> | void;
}

export function useFileSelection({ owner, root, onDeleted }: UseFileSelectionOptions) {
  const [selectMode, setSelectMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  const enterSelectMode = useCallback(() => {
    hapticLight();
    setSelectMode(true);
    setSelectedPaths(new Set());
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedPaths(new Set());
  }, []);

  const toggleSelect = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback((entries: readonly FileEntry[]) => {
    hapticLight();
    setSelectedPaths((prev) =>
      prev.size === entries.length ? new Set() : new Set(entries.map((entry) => entry.path)),
    );
  }, []);

  const runDelete = useCallback(
    async (paths: readonly string[]) => {
      let failed = 0;
      for (const path of paths) {
        try {
          const response = await authFetch(buildFileDeleteUrl(path, owner, root), {
            method: 'DELETE',
          });
          if (!response.ok) failed += 1;
        } catch {
          failed += 1;
        }
      }
      const message = summarizeDeleteResult(paths.length, failed);
      if (message) Alert.alert('错误', message);
      await onDeleted();
    },
    [owner, root, onDeleted],
  );

  /** 弹出二次确认；确认后逐个删除并刷新列表 */
  const confirmDelete = useCallback(
    (entries: readonly FileEntry[]) => {
      const plan = buildFileDeletePlan(entries);
      if (!plan) return;
      showActionMenu({
        title: plan.title,
        message: plan.message,
        actions: [
          {
            label: plan.confirmLabel,
            destructive: true,
            onPress: () => {
              void runDelete(plan.paths).then(() => exitSelectMode());
            },
          },
        ],
      });
    },
    [runDelete, exitSelectMode],
  );

  return {
    selectMode,
    selectedPaths,
    selectedCount: selectedPaths.size,
    hasSelection: selectedPaths.size > 0,
    enterSelectMode,
    exitSelectMode,
    toggleSelect,
    toggleSelectAll,
    confirmDelete,
  };
}
