/**
 * 文件中心的本地偏好（排序 + 列表/网格布局）。
 *
 * 存储键与 Web `FileBrowser` 的 localStorage 键同名（`files.sort` / `files.layout`），
 * 沿用移动端既有的 AsyncStorage 持久化方式；排序按「文件夹视图 / 所有文件」
 * 各记一份，与 Web 的 SortPrefs 结构一致。
 */
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { FileSortKey, FileSortOrder } from '@agent/shared';
import type { FileLayoutMode } from '../components/files/FileBrowserBody';

const SORT_STORAGE_KEY = 'files.sort';
const LAYOUT_STORAGE_KEY = 'files.layout';

export type FileViewMode = 'folder' | 'all';

export interface SortPref {
  key: FileSortKey;
  order: FileSortOrder;
}

export interface SortPrefs {
  folder: SortPref;
  all: SortPref;
}

export const DEFAULT_SORT_PREFS: SortPrefs = {
  folder: { key: 'modifiedAt', order: 'desc' },
  all: { key: 'modifiedAt', order: 'desc' },
};

export function useFileBrowserPrefs() {
  const [sortPrefs, setSortPrefs] = useState<SortPrefs>(DEFAULT_SORT_PREFS);
  const [layoutMode, setLayoutMode] = useState<FileLayoutMode>('list');

  useEffect(() => {
    AsyncStorage.multiGet([SORT_STORAGE_KEY, LAYOUT_STORAGE_KEY])
      .then((pairs) => {
        for (const [key, raw] of pairs) {
          if (!raw) continue;
          if (key === LAYOUT_STORAGE_KEY) {
            if (raw === 'grid' || raw === 'list') setLayoutMode(raw);
            continue;
          }
          try {
            const saved = JSON.parse(raw) as Partial<SortPrefs>;
            setSortPrefs((prev) => ({
              folder: { ...prev.folder, ...saved.folder },
              all: { ...prev.all, ...saved.all },
            }));
          } catch {
            /* 损坏的偏好直接忽略，回落默认值 */
          }
        }
      })
      .catch(() => {});
  }, []);

  const updateSort = useCallback((mode: FileViewMode, next: SortPref) => {
    setSortPrefs((prev) => {
      const merged = { ...prev, [mode]: next };
      AsyncStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(merged)).catch(() => {});
      return merged;
    });
  }, []);

  const updateLayoutMode = useCallback((mode: FileLayoutMode) => {
    setLayoutMode(mode);
    AsyncStorage.setItem(LAYOUT_STORAGE_KEY, mode).catch(() => {});
  }, []);

  return { sortPrefs, layoutMode, updateSort, updateLayoutMode };
}
