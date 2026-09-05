/**
 * 文件中心头部下拉菜单的纯构造与解析（无 React / RN 依赖，可单测）。
 *
 * 对齐 Web `FileBrowser` 头部的四组控制：布局（列表/网格）、排序、刷新、
 * 管理员的根目录与 owner 过滤。移动端头部塞不下四组分段控件，
 * 统一收进一个「…」下拉，语义与 Web 一一对应。
 */
import { FILE_SORT_LABELS, type FileSortKey, type FileSortOrder } from '@agent/shared';
import type { DropdownSection } from '../overlays/DropdownMenu';
import type { FileLayoutMode } from './FileBrowserBody';

export const FILE_SORT_KEYS: readonly FileSortKey[] = ['name', 'modifiedAt', 'size', 'extension'];

export const FILE_MENU_IDS = {
  layoutList: '_layout:list',
  layoutGrid: '_layout:grid',
  refresh: '_refresh',
  root: '_root',
  ownerPrefix: '_owner:',
} as const;

export interface FileMenuOwner {
  username: string;
  realName?: string;
}

export interface FileMenuInput {
  sortKey: FileSortKey;
  sortOrder: FileSortOrder;
  layoutMode: FileLayoutMode;
  /** 管理员才有根目录与 owner 过滤 */
  isAdmin?: boolean;
  /** 只读用户列表（`useUsers`）；非管理员传空 */
  users?: readonly FileMenuOwner[];
  ownerFilter?: string | null;
  /** 子目录页不提供「根目录」入口 */
  includeRootEntry?: boolean;
}

export function buildFileMenuSections(input: FileMenuInput): DropdownSection[] {
  const sections: DropdownSection[] = [
    {
      id: '_layout_section',
      label: '布局',
      actions: [
        { id: FILE_MENU_IDS.layoutList, label: '列表', checked: input.layoutMode === 'list' },
        { id: FILE_MENU_IDS.layoutGrid, label: '网格', checked: input.layoutMode === 'grid' },
      ],
    },
    {
      id: '_sort_section',
      label: `排序 (${input.sortOrder === 'asc' ? '升序' : '降序'})`,
      actions: FILE_SORT_KEYS.map((key) => {
        const active = input.sortKey === key;
        const arrow = active ? (input.sortOrder === 'asc' ? ' ↑' : ' ↓') : '';
        return { id: key, label: `${FILE_SORT_LABELS[key]}${arrow}`, checked: active };
      }),
    },
    {
      id: '_actions_section',
      actions: [{ id: FILE_MENU_IDS.refresh, label: '刷新' }],
    },
  ];

  if (input.isAdmin && input.includeRootEntry) {
    sections.push({ id: '_nav_section', actions: [{ id: FILE_MENU_IDS.root, label: '根目录' }] });
  }

  const users = input.users ?? [];
  if (input.isAdmin && users.length > 0) {
    sections.push({
      id: '_owner_section',
      label: '工作区',
      actions: users.map((user) => ({
        id: `${FILE_MENU_IDS.ownerPrefix}${user.username}`,
        label: user.realName || user.username,
        checked: input.ownerFilter === user.username,
      })),
    });
  }

  return sections;
}

export type FileMenuAction =
  | { type: 'layout'; mode: FileLayoutMode }
  | { type: 'sort'; key: FileSortKey }
  | { type: 'refresh' }
  | { type: 'root' }
  | { type: 'owner'; username: string };

export function parseFileMenuAction(actionId: string): FileMenuAction | null {
  if (actionId === FILE_MENU_IDS.layoutList) return { type: 'layout', mode: 'list' };
  if (actionId === FILE_MENU_IDS.layoutGrid) return { type: 'layout', mode: 'grid' };
  if (actionId === FILE_MENU_IDS.refresh) return { type: 'refresh' };
  if (actionId === FILE_MENU_IDS.root) return { type: 'root' };
  if (actionId.startsWith(FILE_MENU_IDS.ownerPrefix)) {
    const username = actionId.slice(FILE_MENU_IDS.ownerPrefix.length);
    return username ? { type: 'owner', username } : null;
  }
  if ((FILE_SORT_KEYS as readonly string[]).includes(actionId)) {
    return { type: 'sort', key: actionId as FileSortKey };
  }
  return null;
}

/** 点同一列 = 翻转方向；换列 = 用该列默认方向（时间倒序，其余正序） */
export function nextSortState(
  current: { key: FileSortKey; order: FileSortOrder },
  key: FileSortKey,
): { key: FileSortKey; order: FileSortOrder } {
  if (current.key === key) {
    return { key, order: current.order === 'asc' ? 'desc' : 'asc' };
  }
  return { key, order: key === 'modifiedAt' ? 'desc' : 'asc' };
}
