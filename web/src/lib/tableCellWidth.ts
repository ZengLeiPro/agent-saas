import React, { ReactNode } from 'react';

/**
 * 表格单元格宽度估算
 *
 * 用途：让 markdown 表格在「允许换行 + 最多 N 行」的约束下自适应列宽。
 * 思路：自然换行行数 = ⌈文本宽度 / 列宽⌉，要保证行数 ≤ N，
 *      必须 列宽 ≥ 文本宽度 / N。把这个值作为 cell 的 min-width
 *      推高列宽，浏览器 table-layout: auto 会自然完成布局。
 */

const MAX_LINES = 4;

/** 默认表格字号（与 .prose table 实际渲染字号保持一致；prose 默认 0.875em，按 16px 根字号 ≈ 14px） */
const DEFAULT_FONT_SIZE_PX = 14;

/** 单元格的水平 padding 估算（左右各 ~6px），用于补偿到 min-width */
const CELL_PAD_PX = 12;

/** min-width 下限，避免极短文本撑出过窄的列 */
const MIN_CELL_WIDTH_PX = 56;

/** 递归从 React children 中提取纯文本（用于宽度估算，丢弃节点结构） */
export function extractTextFromChildren(children: ReactNode): string {
  if (children == null || typeof children === 'boolean') return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractTextFromChildren).join('');
  if (React.isValidElement(children)) {
    const props = children.props as { children?: ReactNode };
    return extractTextFromChildren(props.children);
  }
  return '';
}

/**
 * 估算字符串渲染宽度（px）。
 * CJK / Hangul / Hiragana / Katakana 按 1em，ASCII 空格按 0.27em，其它按 0.54em。
 * 经验值，与 mobile 端 estimateTextWidth 保持一致的比例。
 */
export function estimateTextWidthPx(text: string, fontSizePx: number = DEFAULT_FONT_SIZE_PX): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (
      (c >= 0x4e00 && c <= 0x9fff) || // CJK 统一汉字
      (c >= 0x3000 && c <= 0x303f) || // CJK 标点
      (c >= 0xff00 && c <= 0xffef) || // 全角
      (c >= 0x3040 && c <= 0x309f) || // Hiragana
      (c >= 0x30a0 && c <= 0x30ff) || // Katakana
      (c >= 0xac00 && c <= 0xd7af)    // Hangul
    ) {
      w += fontSizePx;
    } else if (c === 0x20) {
      w += fontSizePx * 0.27;
    } else {
      w += fontSizePx * 0.54;
    }
  }
  return w;
}

/**
 * 计算 cell 的 min-width（px），保证自然换行后不超过 MAX_LINES 行。
 */
export function getCellMinWidthPx(text: string, maxLines: number = MAX_LINES): number {
  if (!text) return MIN_CELL_WIDTH_PX;
  const textWidth = estimateTextWidthPx(text);
  return Math.max(MIN_CELL_WIDTH_PX, Math.ceil(textWidth / maxLines) + CELL_PAD_PX);
}
