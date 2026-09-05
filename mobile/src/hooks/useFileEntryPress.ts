/**
 * 文件条目点击分派 —— `/files` 与 `/files/browse` 共用。
 *
 * 目录进子目录；文件按 `resolveFilePreviewTarget`（shared `getPreviewFileType`
 * 的移动端封装）分派到 Markdown 预览 / 通用预览 / 下载分享三条路。
 * HTML/SVG 归在通用预览的 `html` 档，那里只给下载分享与安全提示，
 * 不做任何内嵌渲染（M50-03）。
 */
import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import type { FileEntry } from '@agent/shared';
import { resolveFilePreviewTarget } from '../lib/filePreviewTarget';
import { useFileOpen } from './useFileOpen';

export interface UseFileEntryPressOptions {
  owner?: string;
  root?: boolean;
}

export function useFileEntryPress({ owner, root }: UseFileEntryPressOptions) {
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
      if (target.route === '/chat/markdown-preview') {
        router.push({
          pathname: '/chat/markdown-preview',
          params: { filePath: entry.path, ...commonParams() },
        });
        return;
      }
      if (target.route === '/files/preview') {
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
    [router, commonParams, open, owner, root],
  );

  return { press, downloading };
}
