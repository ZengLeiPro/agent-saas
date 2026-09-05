/**
 * 移动端文件预览分派（纯逻辑，无 React / RN 依赖，可单测）。
 *
 * 类型判定唯一来源是 shared `getPreviewFileType`（与 Web `FilePreviewPanel`
 * 同一口径），mobile 在其之上补两件事：
 *
 * 1. **主动内容降级**：HTML/SVG 在移动端永不内嵌渲染。M50-03 已关闭旧的
 *    workspace HTML 内嵌预览，`artifactViewAdapter` 也把 artifact 的 `html`
 *    viewKind 映射成 `download-only`。因此这里把 html/svg 统一归到 `html`
 *    这一档，UI 只给「下载 / 分享」+ 安全提示，不给渲染入口。
 * 2. **KB 伪协议**：`kb://<doc>#page=N` 的取数走 `/api/kb/file`
 *    （见 `services/fileCacheService.ts` 的 kb 分支），类型仍按 doc 文件名判定。
 */
import { getPreviewFileType, isKbPath, parseKbPath } from '@agent/shared';

export type FilePreviewKind = 'markdown' | 'code' | 'text' | 'pdf' | 'video' | 'html' | 'download';

/** 主动内容扩展名：SVG 可携带脚本，和 HTML 同等对待 */
const ACTIVE_CONTENT_RE = /\.(svgz?|xhtml)$/i;

export interface FilePreviewTarget {
  kind: FilePreviewKind;
  /** expo-router 路由；null = 不跳转，直接走下载/分享 */
  route: '/chat/markdown-preview' | '/files/preview' | null;
}

/** KB 伪协议解析结果：非 kb 路径时 `isKb=false`，`doc` 即原路径 */
export interface KbPreviewSource {
  isKb: boolean;
  doc: string;
  page?: number;
}

export function resolveKbPreviewSource(path: string): KbPreviewSource {
  if (!isKbPath(path)) return { isKb: false, doc: path };
  const parsed = parseKbPath(path);
  if (!parsed) return { isKb: true, doc: '' };
  return { isKb: true, doc: parsed.doc, ...(parsed.page ? { page: parsed.page } : {}) };
}

export function resolveFilePreviewKind(fileName: string): FilePreviewKind {
  const doc = resolveKbPreviewSource(fileName).doc;
  if (ACTIVE_CONTENT_RE.test(doc)) return 'html';
  switch (getPreviewFileType(doc)) {
    case 'md':
      return 'markdown';
    case 'html':
      return 'html';
    case 'pdf':
      return 'pdf';
    case 'video':
      return 'video';
    case 'code':
      return 'code';
    case 'text':
      return 'text';
    default:
      return 'download';
  }
}

export function resolveFilePreviewTarget(fileName: string): FilePreviewTarget {
  const kind = resolveFilePreviewKind(fileName);
  if (kind === 'download') return { kind, route: null };
  // Markdown 保留会话内既有入口（`/chat/markdown-preview`），
  // 其余类型进通用预览路由 `/files/preview`。
  if (kind === 'markdown') return { kind, route: '/chat/markdown-preview' };
  return { kind, route: '/files/preview' };
}
