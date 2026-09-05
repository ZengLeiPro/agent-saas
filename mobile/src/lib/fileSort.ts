/**
 * 文件列表排序 —— 与 Web `FileBrowser.sortEntries` 逐行同构：
 * 目录恒在前，再按所选列排序，扩展名相同时回退按名称。
 * 纯函数，无 React / RN 依赖。
 */
import type { FileEntry, FileSortKey, FileSortOrder } from '@agent/shared';

export function sortFileEntries<
  T extends Pick<FileEntry, 'name' | 'isDirectory' | 'modifiedAt' | 'size' | 'extension'>,
>(entries: readonly T[], sortKey: FileSortKey, sortOrder: FileSortOrder): T[] {
  const sorted = [...entries];
  sorted.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let cmp = 0;
    switch (sortKey) {
      case 'name':
        cmp = a.name.localeCompare(b.name);
        break;
      case 'modifiedAt':
        cmp = a.modifiedAt - b.modifiedAt;
        break;
      case 'size':
        cmp = a.size - b.size;
        break;
      case 'extension':
        cmp = a.extension.localeCompare(b.extension) || a.name.localeCompare(b.name);
        break;
    }
    return sortOrder === 'asc' ? cmp : -cmp;
  });
  return sorted;
}
