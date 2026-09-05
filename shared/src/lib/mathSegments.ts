/**
 * Markdown 正文里的数学公式切分。
 *
 * Web 侧走 remark-math + rehype-katex（`web/src/lib/markdownRuntime.ts`），
 * 分隔符口径为 `$$…$$` 块级与 `$…$` 行内；这里把「哪一段是公式」的判定
 * 抽成纯函数，供 mobile 在原生 Markdown 渲染链里定位公式段。
 *
 * 判定纪律：
 * - 代码不是公式：围栏代码块（``` / ~~~）与行内代码（`` ` `` 反引号跨度）
 *   内部的 `$` 一律当普通字符，避免把 shell 变量 / 价格误判成公式；
 * - 未闭合的分隔符保持原样输出为文本（流式渲染时半截公式不闪烁）；
 * - 空公式（分隔符之间只有空白）不产出 math 段。
 */

export type MathSegment =
  { type: 'text'; content: string } | { type: 'math'; tex: string; display: boolean };

export interface SplitMathOptions {
  /** 是否切分行内公式（`$…$` / `\(…\)`）。默认只切块级，行内保持原文。 */
  inline?: boolean;
}

/** 块级分隔符：`$$…$$` 与 `\[…\]` */
const BLOCK_DELIMITERS: Array<{ open: string; close: string }> = [
  { open: '$$', close: '$$' },
  { open: '\\[', close: '\\]' },
];

/** 行内分隔符：`$…$` 与 `\(…\)` */
const INLINE_DELIMITERS: Array<{ open: string; close: string }> = [
  { open: '\\(', close: '\\)' },
  { open: '$', close: '$' },
];

function fenceAt(text: string, index: number): string | null {
  if (index !== 0 && text[index - 1] !== '\n') return null;
  const match = /^(`{3,}|~{3,})/.exec(text.slice(index));
  return match ? match[1] : null;
}

/** 行内代码跨度：等长反引号闭合；未闭合时按普通字符处理 */
function inlineCodeEnd(text: string, index: number): number | null {
  const run = /^`+/.exec(text.slice(index))![0];
  const closeIndex = text.indexOf(run, index + run.length);
  if (closeIndex < 0) return null;
  const after = closeIndex + run.length;
  // 更长的反引号串不算闭合（等长才配对）
  return text[after] === '`' ? null : after;
}

export function splitMathSegments(text: string, options: SplitMathOptions = {}): MathSegment[] {
  const delimiters = options.inline
    ? [...BLOCK_DELIMITERS, ...INLINE_DELIMITERS]
    : BLOCK_DELIMITERS;
  const segments: MathSegment[] = [];
  let buffer = '';
  let index = 0;

  const flush = () => {
    if (buffer) segments.push({ type: 'text', content: buffer });
    buffer = '';
  };

  while (index < text.length) {
    const fence = fenceAt(text, index);
    if (fence) {
      const closeIndex = text.indexOf(`\n${fence}`, index + fence.length);
      const end = closeIndex < 0 ? text.length : closeIndex + 1 + fence.length;
      buffer += text.slice(index, end);
      index = end;
      continue;
    }
    if (text[index] === '`') {
      const end = inlineCodeEnd(text, index);
      if (end !== null) {
        buffer += text.slice(index, end);
        index = end;
        continue;
      }
    }

    const matched = delimiters.find((delimiter) => text.startsWith(delimiter.open, index));
    if (matched) {
      const bodyStart = index + matched.open.length;
      const closeIndex = text.indexOf(matched.close, bodyStart);
      if (closeIndex >= 0) {
        const tex = text.slice(bodyStart, closeIndex);
        if (tex.trim()) {
          flush();
          segments.push({
            type: 'math',
            tex: tex.trim(),
            display: matched.open === '$$' || matched.open === '\\[',
          });
          index = closeIndex + matched.close.length;
          continue;
        }
      }
    }

    buffer += text[index];
    index += 1;
  }

  flush();
  return segments;
}

/** 是否存在可渲染的公式段（无公式时调用侧可直接走原有 Markdown 渲染） */
export function hasMathSegments(segments: readonly MathSegment[]): boolean {
  return segments.some((segment) => segment.type === 'math');
}
