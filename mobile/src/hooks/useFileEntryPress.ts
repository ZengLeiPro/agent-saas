/**
 * 文件条目点击分派 —— `/files` 与 `/files/browse` 共用。
 *
 * 目录进子目录；文件按 `resolveFilePreviewTarget` 分派。
 * md+ master-detail 可通过 `onOpenPreview` 拦截预览路由，改为右栏呈现。
 */
import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import type { FileEntry } from '@agent/shared';
import { resolveFilePreviewTarget } from '../lib/filePreviewTarget';
import { useFileOpen } from './useFileOpen';

export type FilePreviewNavTarget = {
  route: '/chat/markdown-preview' | '/files/preview';
  filePath: string;
  name: string;
  size: number;
  modifiedAt: number;
};

export interface UseFileEntryPressOptions {
  owner?: string;
  root?: boolean;
  /**
   * When provided, previewable files call this instead of `router.push`.
   * Return true if handled (typical md+ pane). Directory navigation still pushes.
   */
  onOpenPreview?: (target: FilePreviewNavTarget) => boolean;
}

export function useFileEntryPress({ owner, root, onOpenPreview }: UseFileEntryPressOptions) {
  const router = useRouter();
  const { open, downloading } = useFileOpen();

  const commonParams = useCallback(
    () => ({ ...(owner ? { owner } : {}), ...(root ? { root: 'true' } : {}) }),
    [owner, root],
  );

  const press = useCallback(
    async (entry: FileEntry) => {
      if (entry.isDirectory) {
        router.push({
          pathname: '/files/browse',
          params: { path: entry.path, ...commonParams() },
        });
        return;
      }

      const target = resolveFilePreviewTarget(entry.name);
      if (target.route === '/chat/markdown-preview' || target.route === '/files/preview') {
        const nav: FilePreviewNavTarget = {
          route: target.route,
          filePath: entry.path,
          name: entry.name,
          size: entry.size,
          modifiedAt: entry.modifiedAt,
        };
        if (onOpenPreview?.(nav)) return;

        if (target.route === '/chat/markdown-preview') {
          router.push({
            pathname: '/chat/markdown-preview',
            params: { filePath: entry.path, ...commonParams() },
          });
          return;
        }
        router.push({
          pathname: '/files/preview',
          params: {
            filePath: entry.path,
            name: entry.name,
            size: String(entry.size),
            modifiedAt: String(entry.modifiedAt),
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
    [router, commonParams, open, owner, root, onOpenPreview],
  );

  return { press, downloading };
}
