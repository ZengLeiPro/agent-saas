/**
 * 会话列表多选模式（原生独有）—— 从 `(tabs)/chat/index.tsx` 抽出，行为不变。
 */
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { authFetch } from '@agent/shared';
import { hapticLight, hapticSuccess, hapticWarning } from '../../lib/haptics';

export interface UseSessionSelectionOptions {
  isAdminUser: boolean;
  /** 当前列表可选中的全部行 id（分组行用 `group-<key>`） */
  allRowIds: string[];
  refreshSessions: () => Promise<void>;
  setTabBarHidden: (hidden: boolean) => void;
  closeOpenSwipeable: () => void;
}

export function useSessionSelection({
  isAdminUser,
  allRowIds,
  refreshSessions,
  setTabBarHidden,
  closeOpenSwipeable,
}: UseSessionSelectionOptions) {
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const enterSelectMode = useCallback(() => {
    hapticLight();
    closeOpenSwipeable();
    setIsSelectMode(true);
    setSelectedIds(new Set());
    requestAnimationFrame(() => setTabBarHidden(true));
  }, [closeOpenSwipeable, setTabBarHidden]);

  const exitSelectMode = useCallback(() => {
    setIsSelectMode(false);
    setSelectedIds(new Set());
    requestAnimationFrame(() => setTabBarHidden(false));
  }, [setTabBarHidden]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    hapticLight();
    setSelectedIds((prev) => (prev.size === allRowIds.length ? new Set() : new Set(allRowIds)));
  }, [allRowIds]);

  const batchDelete = useCallback(() => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    hapticWarning();
    Alert.alert(
      isAdminUser ? '批量移至回收站' : '批量删除',
      `确定要删除 ${ids.length} 个会话吗？`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: isAdminUser ? '移至回收站' : '删除',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              for (const sid of ids) {
                try {
                  await authFetch(`/api/sessions/${encodeURIComponent(sid)}?deleteSidecar=true`, {
                    method: 'DELETE',
                  });
                } catch {
                  /* ignore individual failures */
                }
              }
              await refreshSessions();
              exitSelectMode();
              hapticSuccess();
            })();
          },
        },
      ],
    );
  }, [selectedIds, isAdminUser, refreshSessions, exitSelectMode]);

  return {
    isSelectMode,
    selectedIds,
    selectedCount: selectedIds.size,
    allSelected: allRowIds.length > 0 && selectedIds.size === allRowIds.length,
    enterSelectMode,
    exitSelectMode,
    toggleSelect,
    toggleAll,
    batchDelete,
  };
}
