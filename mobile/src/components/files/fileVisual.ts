/**
 * 文件类型视觉解析（纯映射，无 React / RN 依赖，可单测）。
 *
 * 类别与色板的唯一来源是 shared `getFileTypeVisual`（Web `FileBrowser` 与聊天
 * 下载卡共用同一色相语义），mobile 只负责补一个「目录」类别，并把类别映射到
 * `src/lib/icons.ts` 的 `FileTypeIcons` 注册表。
 * 目录不吃 shared 色板：它是文件面板的主导航单位，用主题品牌色，
 * 因此这里返回 `color: null`，由调用方取 `colors.brand[600]`。
 */
import { getFileTypeVisual, type FileTypeCategory } from '@agent/shared';

export type FileVisualCategory = FileTypeCategory | 'folder';

/** 全部视觉类别（与 `src/lib/icons.ts` 的 FileTypeIcons 键集合一致） */
export const FILE_VISUAL_CATEGORIES: readonly FileVisualCategory[] = [
  'folder',
  'pdf',
  'word',
  'ppt',
  'excel',
  'code',
  'image',
  'video',
  'audio',
  'text',
  'archive',
  'default',
];

export interface FileVisualEntry {
  isDirectory: boolean;
  name: string;
}

export interface FileVisual {
  category: FileVisualCategory;
  /** 非目录：shared 色板 hex；目录：null（调用方用主题品牌色） */
  color: string | null;
}

export function resolveFileVisualCategory(entry: FileVisualEntry): FileVisualCategory {
  if (entry.isDirectory) return 'folder';
  return getFileTypeVisual(entry.name).category;
}

export function resolveFileVisual(entry: FileVisualEntry, isDark = false): FileVisual {
  if (entry.isDirectory) return { category: 'folder', color: null };
  const visual = getFileTypeVisual(entry.name);
  return { category: visual.category, color: isDark ? visual.colorDark : visual.color };
}
