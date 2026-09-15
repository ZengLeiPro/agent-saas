/**
 * Pure file-entry click dispatch (no router). Used by `useFileEntryPress`
 * and unit tests: folder vs preview vs OS open.
 */
import type { FileEntry } from '@agent/shared';
import { resolveFilePreviewTarget } from './filePreviewTarget';

export const FILES_USER_ROOT = 'assets';
export const FILES_ADMIN_ROOT = '.';

export type FilePreviewNavTarget = {
  route: '/chat/markdown-preview' | '/files/preview';
  filePath: string;
  name: string;
  size: number;
  modifiedAt: number;
};

export type FileEntryPressDecision =
  | { kind: 'folder'; path: string }
  | { kind: 'preview'; target: FilePreviewNavTarget }
  | { kind: 'open' };

export function isFilesUserRoot(path: string): boolean {
  return path === FILES_USER_ROOT || path === '';
}

export function resolveFileEntryPress(
  entry: Pick<FileEntry, 'path' | 'name' | 'size' | 'modifiedAt' | 'isDirectory'>,
): FileEntryPressDecision {
  if (entry.isDirectory) return { kind: 'folder', path: entry.path };
  const target = resolveFilePreviewTarget(entry.name);
  if (target.route === '/chat/markdown-preview' || target.route === '/files/preview') {
    return {
      kind: 'preview',
      target: {
        route: target.route,
        filePath: entry.path,
        name: entry.name,
        size: entry.size,
        modifiedAt: entry.modifiedAt,
      },
    };
  }
  return { kind: 'open' };
}
