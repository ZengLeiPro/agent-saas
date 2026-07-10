/**
 * 租户共享知识库（KB）文件访问工具（引用溯源卡，2026-07 唯恩批次）
 *
 * `kb://<doc>#page=N` 伪协议：引用卡点击时构造，穿透 FilePreviewContext
 * （零接口改动），由 FilePreviewPanel 识别前缀后分发到 PdfPreviewPanel kb 分支。
 * 实际数据由 server `GET /api/kb/file?path=<doc>` 提供（租户共享只读，
 * tenantId 来自 JWT）。token 拼接方式仿 fileUtils.resolveImageSrc。
 */

import { getPlatform } from '../platform/context';
import { TOKEN_KEY } from './constants';

export const KB_SCHEME = 'kb://';

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

/**
 * 将 KB 文档路径解析为带鉴权 token 的完整 URL（iframe/img src 场景无法带
 * Authorization header）。接受裸 doc 路径或 kb:// 伪协议路径（fragment 丢弃，
 * `#page=N` 由调用侧另行拼到最终 URL 上——它属于浏览器 viewer 而非请求参数）。
 */
export async function resolveKbFileSrc(path: string): Promise<string> {
  const doc = isKbPath(path) ? (parseKbPath(path)?.doc ?? '') : path;
  const platform = getPlatform();
  const token = await platform.secureStorage.getItem(TOKEN_KEY);
  const baseUrl = platform.platformConfig.getBaseUrl();
  let url = `${baseUrl}/api/kb/file?path=${encodeURIComponent(doc)}`;
  if (token) url += `&token=${token}`;
  return url;
}
