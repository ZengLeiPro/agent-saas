/**
 * 文件取数来源选择（纯逻辑，可单测）—— 修掉 P1「KB 根文档引用在移动端 404」。
 *
 * 移动端此前只认工作区端点 `/api/file/{read,download}`，而引用溯源卡指向的是
 * 租户共享知识库文档（Web `CitationCard` 一律走 `resolveKbFileSrc`），
 * 于是 KB 根文档在移动端必然 404。这里按 shared `isKbPath` 分流：
 *   - kb://<doc>#page=N → `/api/kb/file?path=<doc>`（URL 由 shared 拼，含 baseUrl）
 *   - 其余             → `/api/file/read` / `/api/file/download`（相对路径）
 */
import { isKbPath, parseKbPath } from '@agent/shared';

export type FileReadKind = 'workspace' | 'kb';

export interface FileReadSource {
  kind: FileReadKind;
  /** 真实文档路径（kb 已剥掉伪协议与 fragment） */
  doc: string;
  /** kb 引用携带的页码（PDF 定位用；viewer 不支持时忽略） */
  page?: number;
  /**
   * 工作区分支的相对请求路径；kb 分支为 null
   * （kb 的绝对 URL 需要 `resolveKbFileSrc` 拼 baseUrl，不是纯函数）。
   */
  workspaceUrl: string | null;
}

export interface FileReadOptions {
  owner?: string;
  root?: boolean;
}

function buildWorkspaceUrl(
  route: 'read' | 'download',
  path: string,
  options: FileReadOptions,
): string {
  const params = new URLSearchParams({ path });
  if (options.owner) params.set('owner', options.owner);
  if (options.root) params.set('root', 'true');
  return `/api/file/${route}?${params.toString()}`;
}

export function resolveFileReadSource(
  path: string,
  route: 'read' | 'download' = 'read',
  options: FileReadOptions = {},
): FileReadSource {
  if (isKbPath(path)) {
    const parsed = parseKbPath(path);
    return {
      kind: 'kb',
      doc: parsed?.doc ?? '',
      ...(parsed?.page ? { page: parsed.page } : {}),
      workspaceUrl: null,
    };
  }
  return {
    kind: 'workspace',
    doc: path,
    workspaceUrl: buildWorkspaceUrl(route, path, options),
  };
}
