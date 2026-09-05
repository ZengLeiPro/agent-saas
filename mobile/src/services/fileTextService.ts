/**
 * 文本类文件取数（Markdown / 代码 / 纯文本预览共用）。
 *
 * 工作区文件走 `/api/file/read`（返回 `{ content }` JSON），
 * KB 文档走 `/api/kb/file`（返回原始文件流，直接 `text()`）。
 * 分流规则见 `lib/fileReadSource.ts`。
 */
import { authFetch, resolveKbFileSrc } from '@agent/shared';
import { resolveFileReadSource, type FileReadOptions } from '../lib/fileReadSource';

export async function fetchFileText(path: string, options: FileReadOptions = {}): Promise<string> {
  const source = resolveFileReadSource(path, 'read', options);

  if (source.kind === 'kb') {
    if (!source.doc) throw new Error('引用文档路径无效');
    const response = await authFetch(await resolveKbFileSrc(source.doc));
    if (!response.ok) throw new Error(`加载失败: ${response.status}`);
    return response.text();
  }

  const response = await authFetch(source.workspaceUrl!);
  if (!response.ok) throw new Error(`加载失败: ${response.status}`);
  const data = (await response.json()) as { content: string };
  return data.content;
}
