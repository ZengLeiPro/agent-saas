/**
 * 代码 / 纯文本预览的文本准备（纯逻辑，可单测）：
 * JSON 美化 → 按 shared `truncateTextPreview` 截断 → 切行给行号槽。
 *
 * 截断上限默认取 shared `ARTIFACT_TEXT_MAX_BYTES`（与 Artifact 文本视图同一口径）：
 * 移动端把整份文件读进 JS 内存渲染，不设上限会直接拖垮主线程。
 */
import { ARTIFACT_TEXT_MAX_BYTES, truncateTextPreview } from '@agent/shared';

export interface PreparedPreviewText {
  lines: string[];
  truncated: boolean;
  totalBytes: number;
  keptBytes: number;
}

/** JSON 自动美化（解析失败保持原文），与 Web `CodePreviewPanel.normalizeContent` 一致 */
export function normalizePreviewContent(content: string, fileName: string): string {
  if (!/\.jsonc?$/i.test(fileName)) return content;
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

export function preparePreviewText(
  content: string,
  fileName: string,
  maxBytes: number = ARTIFACT_TEXT_MAX_BYTES,
): PreparedPreviewText {
  const normalized = normalizePreviewContent(content, fileName);
  const result = truncateTextPreview(normalized, maxBytes);
  return {
    lines: result.text.split('\n'),
    truncated: result.truncated,
    totalBytes: result.totalBytes,
    keptBytes: result.keptBytes,
  };
}
