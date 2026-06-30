/**
 * Memory Index — Markdown Chunker
 *
 * 语义感知切分：优先在 markdown 标题处断开，保证同主题内容在同一 chunk 内。
 * 超长 section 按 token 数二次切分，保留行号映射和尾部重叠。
 */

import { createHash } from 'node:crypto';
import type { MemoryChunk } from './types.js';

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** markdown 标题行（## 及以下） */
const HEADING_RE = /^#{1,6}\s/;

/**
 * 将 markdown 内容按语义段落切分为 chunks。
 *
 * 策略：
 * 1. 先按标题行拆分为 sections
 * 2. 小 section 合并到前一个 chunk（避免碎片化）
 * 3. 超长 section 按 maxChars 二次切分（带重叠）
 */
export function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number },
): MemoryChunk[] {
  const lines = content.split('\n');
  if (lines.length === 0) return [];

  const maxChars = Math.max(32, chunking.tokens * 4);
  const overlapChars = Math.max(0, chunking.overlap * 4);
  // section 小于 minChars 时合并到前一个 chunk，避免碎片
  const minChars = Math.max(16, Math.floor(maxChars * 0.25));

  // ── Phase 1: 按标题拆分为 sections ──────────────────────────
  const sections: Array<{ lines: Array<{ line: string; lineNo: number }> }> = [];
  let currentSection: Array<{ line: string; lineNo: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;

    if (HEADING_RE.test(line) && currentSection.length > 0) {
      sections.push({ lines: currentSection });
      currentSection = [];
    }
    currentSection.push({ line, lineNo });
  }
  if (currentSection.length > 0) {
    sections.push({ lines: currentSection });
  }

  // ── Phase 2: 合并过小的 section ─────────────────────────────
  const merged: typeof sections = [];
  for (const sec of sections) {
    const secChars = sec.lines.reduce((sum, e) => sum + e.line.length + 1, 0);
    if (merged.length > 0 && secChars < minChars) {
      // 合并到前一个
      merged[merged.length - 1]!.lines.push(...sec.lines);
    } else {
      merged.push({ lines: [...sec.lines] });
    }
  }

  // ── Phase 3: 超长 section 二次切分 + 生成 chunks ────────────
  const chunks: MemoryChunk[] = [];

  const makeChunk = (entries: Array<{ line: string; lineNo: number }>) => {
    if (entries.length === 0) return;
    const first = entries[0]!;
    const last = entries[entries.length - 1]!;
    const text = entries.map((e) => e.line).join('\n');
    chunks.push({
      startLine: first.lineNo,
      endLine: last.lineNo,
      text,
      hash: hashText(text),
    });
  };

  for (const sec of merged) {
    const secChars = sec.lines.reduce((sum, e) => sum + e.line.length + 1, 0);

    if (secChars <= maxChars) {
      makeChunk(sec.lines);
      continue;
    }

    // 超长 section: 按 maxChars 硬切，带尾部重叠
    let buf: Array<{ line: string; lineNo: number }> = [];
    let bufChars = 0;

    for (const entry of sec.lines) {
      const lineSize = entry.line.length + 1;

      if (bufChars + lineSize > maxChars && buf.length > 0) {
        makeChunk(buf);
        // 尾部重叠
        if (overlapChars > 0) {
          let acc = 0;
          const kept: typeof buf = [];
          for (let j = buf.length - 1; j >= 0; j--) {
            const e = buf[j]!;
            acc += e.line.length + 1;
            kept.unshift(e);
            if (acc >= overlapChars) break;
          }
          buf = kept;
          bufChars = kept.reduce((sum, e) => sum + e.line.length + 1, 0);
        } else {
          buf = [];
          bufChars = 0;
        }
      }
      buf.push(entry);
      bufChars += lineSize;
    }
    makeChunk(buf);
  }

  return chunks;
}
