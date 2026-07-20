import { useState, useCallback, useEffect, useRef } from "react";
import type {
  ApiSessionGroup,
  GroupSortingMode,
  GroupSortingPref,
} from "../lib/groupsApi";
import * as api from "../lib/groupsApi";
import { wsClient } from "../lib/wsClient";
import { registerRefresh, unregisterRefresh } from "../lib/refreshBus";
import { getPlatform } from "../platform/context";
import type { ChatSessionIndexItem } from "../types/sidebar";

// ── Groups 本地缓存 ──────────────────────────────────
const GROUPS_CACHE_KEY_PREFIX = "groups:";
const SORTING_CACHE_KEY_PREFIX = "groups-sorting:";

function getGroupsCacheKey(): string {
  return GROUPS_CACHE_KEY_PREFIX + "default";
}

function getSortingCacheKey(): string {
  return SORTING_CACHE_KEY_PREFIX + "default";
}

function saveGroupsCache(groups: ApiSessionGroup[]): void {
  try {
    void getPlatform().storage.setItem(
      getGroupsCacheKey(),
      JSON.stringify(groups),
    );
  } catch {
    /* silent */
  }
}

async function loadGroupsCache(): Promise<ApiSessionGroup[] | null> {
  try {
    const raw = await getPlatform().storage.getItem(getGroupsCacheKey());
    if (!raw) return null;
    const groups = (JSON.parse(raw) as ApiSessionGroup[]).filter(
      api.isUserVisibleGroup,
    );
    return groups.length > 0 ? groups : null;
  } catch {
    return null;
  }
}

function saveSortingCache(pref: GroupSortingPref): void {
  try {
    void getPlatform().storage.setItem(
      getSortingCacheKey(),
      JSON.stringify(pref),
    );
  } catch {
    /* silent */
  }
}

async function loadSortingCache(): Promise<GroupSortingPref | null> {
  try {
    const raw = await getPlatform().storage.getItem(getSortingCacheKey());
    if (!raw) return null;
    return JSON.parse(raw) as GroupSortingPref;
  } catch {
    return null;
  }
}

/** 清除所有 groups 缓存（登出时调用） */
export async function clearGroupsCache(): Promise<void> {
  try {
    void getPlatform().storage.removeItem(getGroupsCacheKey());
    void getPlatform().storage.removeItem(getSortingCacheKey());
  } catch {
    /* silent */
  }
}

// ── Hook ─────────────────────────────────────────────

export interface GroupsEditingState {
  /** 进入编辑时的快照（用于取消时回滚） */
  snapshot: string[];
  /** 实时草稿（拖拽时更新） */
  draft: string[];
}

export function useGroups() {
  const [groups, setGroups] = useState<ApiSessionGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [sorting, setSorting] = useState<GroupSortingPref>({
    mode: "recent",
    order: [],
  });
  const [editing, setEditing] = useState<GroupsEditingState | null>(null);

  const loadGroups = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.fetchGroups();
      setGroups(data);
      saveGroupsCache(data);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSorting = useCallback(async () => {
    try {
      const pref = await api.fetchGroupSorting();
      setSorting(pref);
      saveSortingCache(pref);
    } catch {
      /* silent */
    }
  }, []);

  // 冷启动：先从本地缓存渲染，再后台拉 API 静默替换
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cached, cachedSorting] = await Promise.all([
        loadGroupsCache(),
        loadSortingCache(),
      ]);
      if (!cancelled && cached) {
        setGroups(cached);
      }
      if (!cancelled && cachedSorting) {
        setSorting(cachedSorting);
      }
      if (!cancelled) {
        await Promise.all([loadGroups(), loadSorting()]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadGroups, loadSorting]);

  // 注册到 refreshBus，刷新按钮可触发分组数据更新
  useEffect(() => {
    registerRefresh("groups", async () => {
      await Promise.all([loadGroups(), loadSorting()]);
    });
    return () => unregisterRefresh("groups");
  }, [loadGroups, loadSorting]);

  // 监听 WS groups_changed 事件，防抖刷新分组数据
  const loadGroupsRef = useRef(loadGroups);
  loadGroupsRef.current = loadGroups;
  const loadSortingRef = useRef(loadSorting);
  loadSortingRef.current = loadSorting;
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unsub = wsClient.onMessage((envelope: { data: unknown }) => {
      const data = envelope.data as { type?: string };
      if (data?.type === "groups_changed") {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          void loadGroupsRef.current();
          void loadSortingRef.current();
        }, 500);
      }
    });
    return () => {
      unsub();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, []);

  const createGroup = useCallback(
    async (name: string, sessionIds?: string[]): Promise<string | null> => {
      const group = await api.createGroup(name, sessionIds);
      if (group) {
        if (sessionIds?.length) {
          await loadGroups();
        } else {
          setGroups((prev) => [...prev, group]);
        }
        // 自定义模式下：把新分组 prepend 到 order 前端，并立即保存
        if (sorting.mode === "custom") {
          const newOrder = [
            group.id,
            ...sorting.order.filter((id) => id !== group.id),
          ];
          const next: GroupSortingPref = { mode: "custom", order: newOrder };
          setSorting(next);
          saveSortingCache(next);
          void api.saveGroupSorting(next);
        }
        return group.id;
      }
      return null;
    },
    [loadGroups, sorting],
  );

  const addSessionsToGroup = useCallback(
    async (groupId: string, sessionIds: string[]) => {
      const updated = await api.addSessionsToGroup(groupId, sessionIds);
      if (updated) {
        await loadGroups();
      }
    },
    [loadGroups],
  );

  const removeSessionsFromGroup = useCallback(
    async (groupId: string, sessionIds: string[]) => {
      const updated = await api.removeSessionsFromGroup(groupId, sessionIds);
      if (updated) {
        setGroups((prev) => prev.map((g) => (g.id === groupId ? updated : g)));
      }
    },
    [],
  );

  const deleteGroup = useCallback(async (groupId: string) => {
    const ok = await api.deleteGroup(groupId);
    if (ok) {
      setGroups((prev) => prev.filter((g) => g.id !== groupId));
    }
  }, []);

  const renameGroup = useCallback(async (groupId: string, name: string) => {
    const updated = await api.updateGroup(groupId, { name });
    if (updated) {
      setGroups((prev) => prev.map((g) => (g.id === groupId ? updated : g)));
    }
  }, []);

  // ── Sorting 操作 ──

  /**
   * 切换排序模式。
   * @param mode 'recent' | 'custom'
   * @param fallbackOrder 切到 custom 且当前没有 order 时使用的初始顺序（一般传当前显示顺序的 id 数组）
   */
  const setSortingMode = useCallback(
    async (mode: GroupSortingMode, fallbackOrder?: string[]) => {
      let nextOrder = sorting.order;
      if (
        mode === "custom" &&
        nextOrder.length === 0 &&
        fallbackOrder?.length
      ) {
        nextOrder = fallbackOrder;
      }
      const next: GroupSortingPref = { mode, order: nextOrder };
      setSorting(next);
      saveSortingCache(next);
      const saved = await api.saveGroupSorting(next);
      if (saved) {
        setSorting(saved);
        saveSortingCache(saved);
      }
    },
    [sorting],
  );

  /**
   * 进入编辑态。
   * @param currentOrder 当前显示顺序的 id 数组（由组件根据 sorting.mode 派生后传入）
   */
  const enterEditing = useCallback(
    (currentOrder: string[]) => {
      if (sorting.mode !== "custom") return;
      setEditing({ snapshot: [...currentOrder], draft: [...currentOrder] });
    },
    [sorting],
  );

  const cancelEditing = useCallback(() => {
    setEditing(null);
  }, []);

  const reorderDraft = useCallback((from: number, to: number) => {
    setEditing((prev) => {
      if (!prev) return prev;
      if (
        from === to ||
        from < 0 ||
        to < 0 ||
        from >= prev.draft.length ||
        to >= prev.draft.length
      ) {
        return prev;
      }
      const next = [...prev.draft];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { ...prev, draft: next };
    });
  }, []);

  const commitEditing = useCallback(async () => {
    if (!editing) return;
    const next: GroupSortingPref = { mode: "custom", order: editing.draft };
    setSorting(next);
    saveSortingCache(next);
    setEditing(null);
    const saved = await api.saveGroupSorting(next);
    if (saved) {
      setSorting(saved);
      saveSortingCache(saved);
    }
  }, [editing]);

  return {
    groups,
    loading,
    loadGroups,
    createGroup,
    addSessionsToGroup,
    removeSessionsFromGroup,
    deleteGroup,
    renameGroup,
    // sorting
    sorting,
    editing,
    setSortingMode,
    enterEditing,
    cancelEditing,
    reorderDraft,
    commitEditing,
  };
}

/** 分组菜单项（排序后） */
export interface GroupMenuItem {
  id: string;
  name: string;
  kind: "manual" | "cron";
  count: number;
  updatedAt: number;
}

/**
 * 按用户排序偏好返回分组菜单项。
 * 统一所有分组选择 UI 的排序逻辑，确保各端与 web 端自定义排序一致。
 */
export function getSortedGroupItems(
  groups: ApiSessionGroup[],
  sorting: GroupSortingPref,
  sessions?: readonly ChatSessionIndexItem[],
): GroupMenuItem[] {
  return sortGroupsBySortingPref(groups, sorting, sessions).map((g) => ({
    id: g.id,
    name: g.name,
    kind: g.kind,
    count: g.sessionIds.length,
    updatedAt: g.updatedAt,
  }));
}

/** 按 order 数组排序 groups；不在 order 中的追加到末尾（保持其原相对顺序） */
export function applyGroupOrder(
  groups: ApiSessionGroup[],
  order: readonly string[],
): ApiSessionGroup[] {
  if (groups.length === 0) return groups;
  const map = new Map(groups.map((g) => [g.id, g]));
  const result: ApiSessionGroup[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const g = map.get(id);
    if (g && !seen.has(id)) {
      result.push(g);
      seen.add(id);
    }
  }
  for (const g of groups) {
    if (!seen.has(g.id)) result.push(g);
  }
  return result;
}

/**
 * 根据 sorting 偏好对 groups 排序。
 * - custom 模式：按 sorting.order
 * - recent 模式：传入 sessions 时按"分组内最新会话 updatedAt"倒序，否则按 group.updatedAt 倒序
 */
export function sortGroupsBySortingPref(
  groups: ApiSessionGroup[],
  sorting: GroupSortingPref,
  sessions?: readonly ChatSessionIndexItem[],
): ApiSessionGroup[] {
  if (groups.length === 0) return groups;
  if (sorting.mode === "custom") {
    return applyGroupOrder(groups, sorting.order);
  }
  if (sessions && sessions.length > 0) {
    const sessionMap = new Map(sessions.map((s) => [s.id, s]));
    return [...groups]
      .map((g) => {
        let latest = 0;
        for (const sid of g.sessionIds) {
          const s = sessionMap.get(sid);
          if (s && s.updatedAt > latest) latest = s.updatedAt;
        }
        return { group: g, latest: latest || g.updatedAt };
      })
      .sort((a, b) => b.latest - a.latest)
      .map((x) => x.group);
  }
  return [...groups].sort((a, b) => b.updatedAt - a.updatedAt);
}
