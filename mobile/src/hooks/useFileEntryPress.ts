/**
 * 文件条目点击分派 —— `/files` 与 `/files/browse` 共用。
 *
 * 目录进子目录；文件按 `resolveFilePreviewTarget` 分派。
 * md+ master-detail 可通过 `onOpenPreview` / `onOpenFolder` 拦截，改为栏内呈现。
 */
import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import type { FileEntry } from '@agent/shared';
import { resolveFileEntryPress, type FilePreviewNavTarget } from '../lib/fileEntryPress';
import { useFileOpen } from './useFileOpen';

export type { FilePreviewNavTarget };

export interface UseFileEntryPressOptions {
  owner?: string;
  root?: boolean;
  /**
   * When provided, previewable files call this instead of `router.push`.
   * Return true if handled (typical md+ pane).
   */
  onOpenPreview?: (target: FilePreviewNavTarget) => boolean;
  /**
   * When provided, directories call this instead of pushing `/files/browse`.
   * Return true if handled (md+ in-pane folder drill).
   */
  onOpenFolder?: (path: string) => boolean;
}

export function useFileEntryPress({ owner, root, onOpenPreview, onOpenFolder }: UseFileEntryPressOptions) {
  const router = useRouter();
  const { open, downloading } = useFileOpen();

  const commonParams = useCallback(
    () => ({ ...(owner ? { owner } : {}), ...(root ? { root: 'true' } : {}) }),
    [owner, root],
  );

  const press = useCallback(
    async (entry: FileEntry) => {
      const decision = resolveFileEntryPress(entry);
      if (decision.kind === 'folder') {
        if (onOpenFolder?.(decision.path)) return;
        router.push({
          pathname: '/files/browse',
          params: { path: decision.path, ...commonParams() },
        });
        return;
      }

      if (decision.kind === 'preview') {
        if (onOpenPreview?.(decision.target)) return;
        if (decision.target.route === '/chat/markdown-preview') {
          router.push({
            pathname: '/chat/markdown-preview',
            params: { filePath: decision.target.filePath, ...commonParams() },
          });
          return;
        }
        router.push({
          pathname: '/files/preview',
          params: {
            filePath: decision.target.filePath,
            name: decision.target.name,
            size: String(decision.target.size),
            modifiedAt: String(decision.target.modifiedAt),
            ...commonParams(),
          },
        });
        return;
      }

      await open({
        path: entry.path,
        modifiedAt: entry.modifiedAt,
        size: entry.size,
        ...(owner ? { owner } : {}),
        ...(root ? { root: true } : {}),
      });
    },
    [router, commonParams, open, owner, root, onOpenPreview, onOpenFolder],
  );

  return { press, downloading };
}
