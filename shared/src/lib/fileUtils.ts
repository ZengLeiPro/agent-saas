import { getPlatform } from '../platform/context';
import { TOKEN_KEY } from './constants';
import { getFileTypeVisual } from './fileTypeVisual';
import { ARTIFACT_TEXT_MAX_BYTES } from './artifactViewModel';

/** 判断 src 是否为外部 URL 或 data URI */
function isExternalSrc(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src);
}

/**
 * 将工作区相对路径解析为带鉴权的完整图片 URL。
 * 外部 URL / data URI 原样返回。
 *
 * @param src 图片路径
 * @param owner 跨用户访问时指定的工作区拥有者（admin only）
 * @param referrer 引用此图片的 md 文件路径；后端在 src 无法按工作区根解析时，
 *                 会以 dirname(referrer) 作为 base 重试一次（兼容标准 markdown
 *                 的「相对当前文件」路径写法）。仅 md 预览面板传递。
 */
export async function resolveImageSrc(src: string, owner?: string, referrer?: string): Promise<string> {
  if (isExternalSrc(src)) return src;

  // 防止双重编码：markdown 解析器可能已编码中文字符，先解码再重新编码
  let finalSrc = src;
  try {
    const decoded = decodeURIComponent(src);
    if (decoded !== src) {
      finalSrc = decoded;
    }
  } catch {
    // 解码失败（格式不对），保持原样
  }

  const platform = getPlatform();
  const baseUrl = platform.platformConfig.getBaseUrl();
  let url = `${baseUrl}/api/file/download?path=${encodeURIComponent(finalSrc)}`;
  if (owner) url += `&owner=${encodeURIComponent(owner)}`;
  if (referrer) url += `&referrer=${encodeURIComponent(referrer)}`;
  platform.platformConfig.assertTrustedUrl?.(url, 'http');
  const token = await platform.secureStorage.getItem(TOKEN_KEY);
  if (token) url += `&token=${encodeURIComponent(token)}`;
  return url;
}

/** 生成按任务权限校验的任务附件下载 URL，不依赖上传者工作区路径。 */
export async function resolveTaskAttachmentSrc(
  taskId: string,
  attachmentId: string,
  download = false,
): Promise<string> {
  const platform = getPlatform();
  const baseUrl = platform.platformConfig.getBaseUrl();
  const query = download ? '?download=1' : '';
  const url = `${baseUrl}/api/taskboard/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}${query}`;
  platform.platformConfig.assertTrustedUrl?.(url, 'http');
  const token = await platform.secureStorage.getItem(TOKEN_KEY);
  const tokenQuery = token ? `${query ? '&' : '?'}token=${encodeURIComponent(token)}` : '';
  return `${url}${tokenQuery}`;
}

/** 匹配 .md 文件路径：绝对路径(/...)、相对路径(./... ../...)、或简单相对路径(assets/...) */
export const MD_PATH_RE = /^(?:\/|\.\.?\/|(?![a-zA-Z]+:\/\/)[a-zA-Z0-9_])[^\s]*\.md$/;

/** 匹配 .html/.htm 文件路径（同 MD_PATH_RE 规则） */
export const HTML_PATH_RE = /^(?:\/|\.\.?\/|(?![a-zA-Z]+:\/\/)[a-zA-Z0-9_])[^\s]*\.html?$/;

export type PreviewFileType = 'md' | 'html' | 'pdf' | 'text' | 'code' | 'video';

/**
 * 根据文件名判断可预览类型，不可预览返回 null。
 * - md：markdown 渲染面板
 * - html：iframe 沙箱预览
 * - pdf：iframe 内嵌浏览器原生 PDF 阅读器（移动端 Safari 降级为新标签打开）
 * - text：纯文本（txt/log/csv），复用 markdown 面板展示
 * - code：源码/配置（json/yaml/ts/py/...），带语法高亮展示
 * - video：HTML5 <video> 播放面板
 *
 * 注意：mobile 端只认 md/html（见 mobile MessageItem 的 isPreviewable 判断），
 * 新增的 pdf/video 在 mobile 会落到下载分支，不受影响；pdf/video 仅 web 端面板支持。
 */
export function getPreviewFileType(fileName: string): PreviewFileType | null {
  if (/\.html?$/i.test(fileName)) return 'html';
  if (/\.(md|markdown)$/i.test(fileName)) return 'md';
  if (/\.pdf$/i.test(fileName)) return 'pdf';
  if (/\.csv$/i.test(fileName)) return 'text';
  const { category } = getFileTypeVisual(fileName);
  if (category === 'code') return 'code'; // html/md 已在上方拦截
  if (category === 'video') return 'video';
  if (category === 'text') {
    if (/\.rtf$/i.test(fileName)) return null; // rtf 为富文本控制码，非纯文本
    return 'text';
  }
  return null;
}

export interface ParsedImage {
  data: string;
  mimeType: string;
}

export interface ParsedToolResult {
  images: ParsedImage[];
  text: string;
}

/** 从 tool result JSON 字符串中提取图片内容块 */
export function parseToolResult(result: string): ParsedToolResult {
  try {
    const parsed = JSON.parse(result);
    const blocks = Array.isArray(parsed) ? parsed : [parsed];

    const images: ParsedImage[] = [];
    const textParts: string[] = [];

    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) {
        textParts.push(String(block));
        continue;
      }

      if (block.type === 'image') {
        // MCP 格式: { type: "image", data: "base64...", mimeType: "image/png" }
        if (typeof block.data === 'string' && typeof block.mimeType === 'string') {
          images.push({ data: block.data, mimeType: block.mimeType });
          continue;
        }
        // Content block image 格式: { type: "image", source: { type: "base64", media_type: "...", data: "..." } }
        if (block.source?.type === 'base64' && typeof block.source.data === 'string') {
          images.push({ data: block.source.data, mimeType: block.source.media_type || 'image/png' });
          continue;
        }
      }

      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
        continue;
      }

      // 未知结构化内容 — 回退为 JSON 展示
      textParts.push(JSON.stringify(block, null, 2));
    }

    if (images.length > 0) {
      return { images, text: textParts.join('\n') };
    }
  } catch {
    // 非 JSON，回退为纯文本
  }

  return { images: [], text: result };
}

/** 文本预览截断结果 */
export interface TextPreviewTruncation {
  /** 截断后的文本（未超限时与入参一致） */
  text: string;
  truncated: boolean;
  /** 原文 UTF-8 字节数 */
  totalBytes: number;
  /** 保留的 UTF-8 字节数 */
  keptBytes: number;
}

/**
 * 按 UTF-8 字节上限截断文本预览（默认上限 = `ARTIFACT_TEXT_MAX_BYTES`，
 * 与 Artifact 文本视图同一口径）。
 *
 * 移动端把整份文件读进内存渲染，超大文本会直接把 JS 线程拖垮，
 * 因此代码/纯文本预览统一走这里截断并在 UI 上提示「已截断」。
 * 截断点对齐 UTF-8 字符边界，不会产生半个多字节字符。
 */
export function truncateTextPreview(
  text: string,
  maxBytes: number = ARTIFACT_TEXT_MAX_BYTES,
): TextPreviewTruncation {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const totalBytes = bytes.length;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return { text: '', truncated: totalBytes > 0, totalBytes, keptBytes: 0 };
  }
  if (totalBytes <= maxBytes) {
    return { text, truncated: false, totalBytes, keptBytes: totalBytes };
  }
  // 回退到最近的 UTF-8 字符起始字节（0b10xxxxxx 是续接字节）
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  const kept = bytes.subarray(0, end);
  return {
    text: new TextDecoder().decode(kept),
    truncated: true,
    totalBytes,
    keptBytes: end,
  };
}
