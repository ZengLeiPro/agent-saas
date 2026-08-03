import type { PlatformEvent } from './types.js';

/**
 * Durable EventStore 只保存工具原文。模型投影是原文与 toolCallId 的纯函数：
 * 不看时间、事件排名或会话总量，因此后续追加事件不会改写已经发送过的前缀。
 * PostgreSQL bounded replay 只读取这些有界首尾片段，再复用同一投影函数。
 */
export const MODEL_TOOL_RESULT_MAX_CHARS = 8_000;
export const MODEL_TOOL_RESULT_HEAD_CHARS = 2_000;
export const TOOL_RESULT_PROJECTION_PREFIX_CHARS = MODEL_TOOL_RESULT_MAX_CHARS;
export const TOOL_RESULT_PROJECTION_SUFFIX_CHARS = 6_000;

const MODEL_TOOL_RESULT_TAIL_TARGET_CHARS = 5_600;
const TRACE_LINE_COUNT = 200;
const TRACE_CHAR_COUNT = 6_000;

export interface ToolResultProjectionSource {
  prefix: string;
  suffix: string;
  totalChars: number;
  totalLines: number;
}

export function buildToolResultProjectionSource(content: string): ToolResultProjectionSource {
  const prefix: string[] = [];
  const suffixRing = new Array<string>(TOOL_RESULT_PROJECTION_SUFFIX_CHARS);
  let suffixCount = 0;
  let suffixCursor = 0;
  let totalChars = 0;
  let totalLines = 1;

  for (const char of content) {
    totalChars += 1;
    if (char === '\n') totalLines += 1;
    if (prefix.length < TOOL_RESULT_PROJECTION_PREFIX_CHARS) prefix.push(char);
    if (suffixCount < TOOL_RESULT_PROJECTION_SUFFIX_CHARS) {
      suffixRing[suffixCount] = char;
      suffixCount += 1;
    } else {
      suffixRing[suffixCursor] = char;
      suffixCursor = (suffixCursor + 1) % TOOL_RESULT_PROJECTION_SUFFIX_CHARS;
    }
  }

  const suffix: string[] = [];
  if (suffixCount < TOOL_RESULT_PROJECTION_SUFFIX_CHARS) {
    for (let index = 0; index < suffixCount; index += 1) suffix.push(suffixRing[index]!);
  } else {
    for (let index = 0; index < TOOL_RESULT_PROJECTION_SUFFIX_CHARS; index += 1) {
      suffix.push(suffixRing[(suffixCursor + index) % TOOL_RESULT_PROJECTION_SUFFIX_CHARS]!);
    }
  }

  return {
    prefix: prefix.join(''),
    suffix: suffix.join(''),
    totalChars,
    totalLines,
  };
}

export function projectToolResultContentForModel(content: string, toolCallId: string): string {
  return projectToolResultSourceForModel(buildToolResultProjectionSource(content), toolCallId);
}

export function projectToolResultSourceForModel(
  source: ToolResultProjectionSource,
  toolCallId: string,
): string {
  if (source.totalChars <= MODEL_TOOL_RESULT_MAX_CHARS) return source.prefix;
  return projectLineAware(source, toolCallId) ?? projectByCharacter(source, toolCallId);
}

/** File backend 语义对齐；生产 PG backend 会先在 SQL 边界读取有界首尾片段。 */
export function boundReplayToolResultEvents(events: PlatformEvent[]): PlatformEvent[] {
  const bounded = new Map<number, PlatformEvent>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.type !== 'tool_result') continue;
    const content = projectToolResultContentForModel(event.content, event.toolCallId);
    if (content !== event.content || 'modelContent' in event) {
      const { modelContent: _legacyModelContent, ...rest } = event as typeof event & { modelContent?: string };
      bounded.set(index, { ...rest, content });
    }
  }
  if (bounded.size === 0) return events;
  return events.map((event, index) => bounded.get(index) ?? event);
}

/** 会话详情展示使用的通用头尾截断；不参与模型 exact-prefix 投影。 */
export function truncateReplayToolResultContent(
  content: string,
  maxChars: number,
  toolCallId: string,
): string {
  const chars = Array.from(content);
  if (chars.length <= maxChars) return content;
  if (maxChars <= 0) return '';
  const headCount = Math.min(Math.floor(maxChars / 4), chars.length);
  const quotedId = JSON.stringify(toolCallId);
  let tailCount = Math.max(0, maxChars - headCount - 160);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const omittedEnd = chars.length - tailCount;
    const marker = `\n\n[工具结果过长；中间省略字符 ${headCount + 1}-${omittedEnd}。读取：SessionContext(action="trace", toolCallId=${quotedId}, startChar=${headCount + 1}, charCount=${TRACE_CHAR_COUNT})]\n\n`;
    const overflow = headCount + codePointLength(marker) + tailCount - maxChars;
    if (overflow <= 0) {
      return `${chars.slice(0, headCount).join('')}${marker}${takeTailCodePoints(chars, tailCount)}`;
    }
    tailCount = Math.max(0, tailCount - overflow);
  }
  const marker = `\n\n[工具结果过长；读取：SessionContext(action="trace", toolCallId=${quotedId}, startChar=${headCount + 1}, charCount=${TRACE_CHAR_COUNT})]\n\n`;
  if (headCount + codePointLength(marker) >= maxChars) return takeCodePoints(marker, maxChars);
  tailCount = maxChars - headCount - codePointLength(marker);
  return `${chars.slice(0, headCount).join('')}${marker}${takeTailCodePoints(chars, tailCount)}`;
}

function projectLineAware(source: ToolResultProjectionSource, toolCallId: string): string | null {
  const prefix = Array.from(source.prefix);
  const suffix = Array.from(source.suffix);
  const headCandidate = prefix.slice(0, MODEL_TOOL_RESULT_HEAD_CHARS);
  const headBreak = headCandidate.lastIndexOf('\n');
  if (headBreak < 0) return null;
  const head = headCandidate.slice(0, headBreak + 1);
  const headEndLine = countNewlines(head);

  const initialTailOffset = Math.max(0, suffix.length - MODEL_TOOL_RESULT_TAIL_TARGET_CHARS);
  const initialTailBreak = suffix.indexOf('\n', initialTailOffset);
  if (initialTailBreak < 0 || initialTailBreak >= suffix.length - 1) return null;
  let tailOffset = initialTailBreak + 1;

  while (tailOffset < suffix.length) {
    const tail = suffix.slice(tailOffset);
    // 超长单行会让“只保留完整行”浪费大部分预算；此时改用字符区间，仍保留真实首尾。
    if (head.length + tail.length < MODEL_TOOL_RESULT_MAX_CHARS / 2) return null;
    const tailStartLine = source.totalLines - countNewlines(tail);
    const omittedStartLine = headEndLine + 1;
    const omittedEndLine = tailStartLine - 1;
    if (omittedStartLine > omittedEndLine) return null;
    const marker = lineMarker({
      toolCallId,
      totalChars: source.totalChars,
      totalLines: source.totalLines,
      headEndLine,
      tailStartLine,
      omittedStartLine,
      omittedEndLine,
    });
    if (head.length + codePointLength(marker) + tail.length <= MODEL_TOOL_RESULT_MAX_CHARS) {
      return `${head.join('')}${marker}${tail.join('')}`;
    }
    const nextBreak = suffix.indexOf('\n', tailOffset);
    if (nextBreak < 0 || nextBreak >= suffix.length - 1) return null;
    tailOffset = nextBreak + 1;
  }
  return null;
}

function projectByCharacter(source: ToolResultProjectionSource, toolCallId: string): string {
  const prefix = Array.from(source.prefix);
  const suffix = Array.from(source.suffix);
  const head = prefix.slice(0, MODEL_TOOL_RESULT_HEAD_CHARS);
  let tailCount = Math.min(suffix.length, MODEL_TOOL_RESULT_MAX_CHARS - head.length);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tailStartChar = source.totalChars - tailCount + 1;
    const omittedStartChar = head.length + 1;
    const omittedEndChar = tailStartChar - 1;
    const marker = charMarker({
      toolCallId,
      totalChars: source.totalChars,
      totalLines: source.totalLines,
      headEndChar: head.length,
      tailStartChar,
      omittedStartChar,
      omittedEndChar,
    });
    const nextTailCount = Math.min(
      suffix.length,
      Math.max(0, MODEL_TOOL_RESULT_MAX_CHARS - head.length - codePointLength(marker)),
    );
    if (nextTailCount === tailCount) {
      return `${head.join('')}${marker}${takeTailCodePoints(suffix, tailCount)}`;
    }
    tailCount = nextTailCount;
  }

  const marker = charMarker({
    toolCallId,
    totalChars: source.totalChars,
    totalLines: source.totalLines,
    headEndChar: head.length,
    tailStartChar: source.totalChars - tailCount + 1,
    omittedStartChar: head.length + 1,
    omittedEndChar: source.totalChars - tailCount,
  });
  return takeCodePoints(`${head.join('')}${marker}${takeTailCodePoints(suffix, tailCount)}`, MODEL_TOOL_RESULT_MAX_CHARS);
}

function lineMarker(input: {
  toolCallId: string;
  totalChars: number;
  totalLines: number;
  headEndLine: number;
  tailStartLine: number;
  omittedStartLine: number;
  omittedEndLine: number;
}): string {
  const quotedId = JSON.stringify(input.toolCallId);
  const lineCount = Math.min(TRACE_LINE_COUNT, input.omittedEndLine - input.omittedStartLine + 1);
  return `\n[tool_result 已截断：共 ${input.totalLines} 行/${input.totalChars} 字符；保留 1-${input.headEndLine}、${input.tailStartLine}-${input.totalLines} 行；省略 ${input.omittedStartLine}-${input.omittedEndLine} 行。\n按行读取：SessionContext(action="trace", toolCallId=${quotedId}, startLine=${input.omittedStartLine}, lineCount=${lineCount})\n关键字定位：SessionContext(action="trace", toolCallId=${quotedId}, query="关键字")]\n`;
}

function charMarker(input: {
  toolCallId: string;
  totalChars: number;
  totalLines: number;
  headEndChar: number;
  tailStartChar: number;
  omittedStartChar: number;
  omittedEndChar: number;
}): string {
  const quotedId = JSON.stringify(input.toolCallId);
  const charCount = Math.min(TRACE_CHAR_COUNT, input.omittedEndChar - input.omittedStartChar + 1);
  return `\n[tool_result 已截断：共 ${input.totalLines} 行/${input.totalChars} 字符；保留字符 1-${input.headEndChar}、${input.tailStartChar}-${input.totalChars}；省略 ${input.omittedStartChar}-${input.omittedEndChar}。\n按字符读取：SessionContext(action="trace", toolCallId=${quotedId}, startChar=${input.omittedStartChar}, charCount=${charCount})\n关键字定位：SessionContext(action="trace", toolCallId=${quotedId}, query="关键字")]\n`;
}

function codePointLength(value: string): number {
  let length = 0;
  for (const _char of value) length += 1;
  return length;
}

function takeCodePoints(value: string, count: number): string {
  if (count <= 0) return '';
  const result: string[] = [];
  for (const char of value) {
    if (result.length >= count) break;
    result.push(char);
  }
  return result.join('');
}

function takeTailCodePoints(chars: string[], count: number): string {
  if (count <= 0) return '';
  return chars.slice(Math.max(0, chars.length - count)).join('');
}

function countNewlines(chars: string[]): number {
  let count = 0;
  for (const char of chars) if (char === '\n') count += 1;
  return count;
}
