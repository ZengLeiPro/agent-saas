/**
 * 租户共享知识库（KB）文件访问工具（引用溯源卡，2026-07 唯恩批次）
 *
 * `kb://<doc>#page=N` 伪协议：引用卡点击时构造，穿透 FilePreviewContext
 * （零接口改动），由 FilePreviewPanel 识别前缀后分发到 PdfPreviewPanel kb 分支。
 * 实际数据由 server `GET /api/kb/file?path=<doc>` 提供（租户共享只读，
 * tenantId 来自 JWT）。token 拼接方式仿 fileUtils.resolveImageSrc。
 */

import { getPlatform } from '../platform/context';

export const KB_SCHEME = 'kb://';

export interface KbPreviewManifest {
  schemaVersion: 1;
  sourcePath: string;
  sourceSha256: string;
  sourceSize: number;
  sourceMtimeMs: number;
  pageCount: number;
  width: number;
  format: 'webp';
  quality: number;
  generatedAt: string;
}

export function isKbPath(path: string): boolean {
  return path.startsWith(KB_SCHEME);
}

/** 构造引用卡点击穿透用的伪协议路径：`kb://<doc>#page=N`（page 缺省不带 fragment） */
export function buildKbPreviewPath(doc: string, page?: number): string {
  return `${KB_SCHEME}${doc}${page ? `#page=${page}` : ''}`;
}

/** 解析 kb:// 伪协议路径。非 kb 路径或 doc 为空返回 null；page 非正整数丢弃。 */
export function parseKbPath(path: string): { doc: string; page?: number } | null {
  if (!isKbPath(path)) return null;
  const rest = path.slice(KB_SCHEME.length);
  const hashIndex = rest.indexOf('#');
  const doc = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest;
  if (!doc) return null;
  let page: number | undefined;
  if (hashIndex >= 0) {
    const match = /^page=(\d+)$/.exec(rest.slice(hashIndex + 1));
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isInteger(parsed) && parsed > 0) page = parsed;
    }
  }
  return { doc, ...(page ? { page } : {}) };
}

function kbApiUrl(route: string, params: Record<string, string | number>): string {
  const baseUrl = getPlatform().platformConfig.getBaseUrl();
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) search.set(key, String(value));
  return `${baseUrl}/api/kb/${route}?${search.toString()}`;
}

/** 原始 KB 文件 URL。鉴权必须放 Authorization header，不再把长期 JWT 拼进查询参数。 */
export async function resolveKbFileSrc(path: string): Promise<string> {
  const doc = isKbPath(path) ? (parseKbPath(path)?.doc ?? '') : path;
  return kbApiUrl('file', { path: doc });
}

export function buildKbPreviewManifestUrl(doc: string): string {
  return kbApiUrl('preview-manifest', { path: doc });
}

export function buildKbPreviewPageUrl(doc: string, page: number, version: string): string {
  if (!Number.isInteger(page) || page < 1) throw new Error('预览页码必须是正整数');
  return kbApiUrl('preview', { path: doc, page, version });
}
