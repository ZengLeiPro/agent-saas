/**
 * 消息内嵌标记（[FILE] / [CITE]）统一切分
 *
 * 由 web MessageItem 的 splitByFileMarkers 泛化而来：
 * - FILE 分支与原实现逐行为等价（JSON 解析失败静默跳过标记、filePath 缺失跳过）——
 *   兼容性红线：纯 FILE 输入的切分输出必须与旧逻辑一致。
 * - CITE 分支（引用溯源卡，2026-07 唯恩批次）：JSON 失败或 doc 非法时**整个
 *   match 原样保留为文本**（不吞不崩）；page 非正整数丢弃；label 缺省 =
 *   doc basename + ` p.N`。
 */

/** [FILE]{...}[/FILE] 与 [CITE]{...}[/CITE]，反向引用保证首尾配对 */
export const MESSAGE_MARKER_RE = /\[(FILE|CITE)\](\{.*?\})\[\/\1\]/g;

export type MarkerSegment =
  | { type: 'text'; content: string }
  | { type: 'file'; filePath: string; fileName: string }
  | { type: 'citation'; doc: string; page?: number; label: string };

export type CitationSegment = Extract<MarkerSegment, { type: 'citation' }>;

/**
 * 解析 [CITE] 标记的 JSON payload。
 * 失败（非 JSON / doc 缺失或非字符串 / doc 为空）返回 null——调用侧将整个
 * match 原样保留为文本。page 非正整数时丢弃（仅丢 page，引用卡仍渲染）。
 */
export function parseCitationPayload(raw: string): CitationSegment | null {
  try {
    const json = JSON.parse(raw) as { doc?: unknown; page?: unknown; label?: unknown };
    const doc = typeof json.doc === 'string' ? json.doc.trim() : '';
    if (!doc) return null;
    const page = typeof json.page === 'number' && Number.isInteger(json.page) && json.page > 0
      ? json.page
      : undefined;
    const baseName = doc.split('/').pop() || doc;
    const label = typeof json.label === 'string' && json.label.trim()
      ? json.label.trim()
      : `${baseName}${page ? ` p.${page}` : ''}`;
    return { type: 'citation', doc, ...(page ? { page } : {}), label };
  } catch {
    return null;
  }
}

/**
 * 按 [FILE]/[CITE] 标记切分文本，返回文本段与卡片段交错的序列。
 *
 * FILE 分支行为与 web 旧 splitByFileMarkers 逐行为等价；CITE 解析失败时整个
 * match（含首尾标记）作为文本原样保留。
 */
export function splitByMessageMarkers(text: string): MarkerSegment[] {
  const segments: MarkerSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(MESSAGE_MARKER_RE)) {
    const before = text.slice(lastIndex, match.index);
    if (match[1] === 'FILE') {
      if (before.trim()) segments.push({ type: 'text', content: before });
      try {
        const json = JSON.parse(match[2]);
        const filePath = json.filePath || '';
        const fileName = filePath.split('/').pop() || filePath;
        segments.push({ type: 'file', filePath, fileName });
      } catch { /* malformed JSON — skip */ }
      lastIndex = match.index! + match[0].length;
      continue;
    }
    // CITE
    const citation = parseCitationPayload(match[2]);
    if (!citation) {
      // 解析失败：不推进 lastIndex，让整个 match 落进下一个文本段原样显示
      continue;
    }
    if (before.trim()) segments.push({ type: 'text', content: before });
    segments.push(citation);
    lastIndex = match.index! + match[0].length;
  }
  const tail = text.slice(lastIndex);
  if (tail.trim()) segments.push({ type: 'text', content: tail });
  return segments;
}

/** 匹配「文本尾部存在未闭合的 [CITE]」：从最后一个无 [/CITE] 收尾的 [CITE] 起裁到结尾 */
const PARTIAL_CITE_TAIL_RE = /\[CITE\](?![\s\S]*\[\/CITE\])[\s\S]*$/;

/**
 * 流式渲染时抑制半截 [CITE] 标记：只裁掉未闭合的尾部，已闭合的标记不受影响。
 * 仅在 message.streaming 时调用；完成后的文本走完整解析。
 */
export function stripPartialCiteMarker(text: string): string {
  return text.replace(PARTIAL_CITE_TAIL_RE, '');
}
