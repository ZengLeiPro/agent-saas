/**
 * Transcript 解析模块
 *
 * 将 JSONL 格式的 transcript 解析为结构化的 blocks。
 */
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as readline from "node:readline";
import { apiLogger } from "../../utils/logger.js";
import { ContextTokenAccumulator } from "../../runtime/contextAccounting.js";
import { truncateReplayToolResultContent } from "../../runtime/replayEventBounds.js";
import type { ModelResponseMode } from "../../runtime/types.js";
import { computeCacheHitDenominatorTokens, computeUsageTotalTokens } from "../usage/pricing.js";
import {
  openTrustedTranscript,
  statTrustedTranscript,
  trustedTranscriptLocation,
} from "./trusted.js";
import {
  readTrustedTranscriptHeadLines,
  readTrustedTranscriptTailLines,
} from "./trustedSummaryRead.js";

export type TranscriptBlockKind =
  | "prompt"
  | "text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "compaction"
  | "meta";

export interface TranscriptSubagentActivity {
  agentType: string;
  description: string;
  childSessionId: string;
  childRunId: string;
  model?: string;
  status: "running" | "completed" | "failed" | "cancelled" | "timeout";
  durationMs?: number;
  totalTokens?: number;
  toolUseCount?: number;
  turnCount?: number;
  errorMessage?: string;
  resultPreview?: string;
}

export interface TranscriptBlock {
  id: string;
  tsMs?: number;
  kind: TranscriptBlockKind;
  title: string;
  defaultOpen: boolean;
  /** Human-friendly content shown by default */
  content: string;
  /** Optional raw JSON for debugging */
  raw?: string;
  /** Mark blocks that represent an error */
  isError?: boolean;
  /** Tool name (for tool_use/tool_result) */
  toolName?: string;
  /** Tool use ID (for correlation) */
  toolId?: string;
  /** Activity duration derived from runtime events, when available */
  durationMs?: number;
  /** Tool lifecycle state derived from durable runtime events */
  executionStatus?: "pending" | "running" | "completed" | "failed" | "cancelled";
  /** Agent 工具对应的 durable child run 元数据。 */
  subagent?: TranscriptSubagentActivity;
  /** User prompt originated from mobile voice transcription */
  isVoiceTranscript?: boolean;
  /** User prompt 携带的附件元数据（来自 transcript user 行顶层 attachments 字段） */
  attachments?: Array<{ name: string; isImage?: boolean; relativePath?: string }>;
  /** 用户消息客户端幂等 ID；刷新后继续用于消息与队列精确对账。 */
  clientMsgId?: string;
  /** 插话来源 run ID；detail API 据此排除已经投影进时间线的 pending steering。 */
  interjectionSourceRunId?: string;
  /** compaction block：被摘要替代的历史事件数 */
  coveredEventCount?: number;
  /** assistant 行对应的 runtime event id；用于按成功 Run 终态追认最终输出。 */
  sourceEventId?: string;
  /** assistant 行所属 runtime run id。 */
  runId?: string;
  /** text block 是否是所属 Run 成功终态的最终输出。 */
  finalOutput?: boolean;
  /** 门禁拒答合成 assistant 行关联的 guardrail event id（员工申诉入口用） */
  guardrailEventId?: string;
  /**
   * tool_use block：工具执行的「给人看」摘要。
   *
   * 类型刻意是 `unknown` 而非 ToolPresentation——本文件是不可信边界
   * （JSONL 可能被手改、可能来自旧版本、可能来自 fork），真正的校验器是
   * shared 的 `normalizeToolPresentation`。在这里标强类型等于把校验责任
   * 错放到一个不做校验的地方。
   *
   * 落盘写在 tool_result 行上（tool_use 行在工具执行前就已写出），
   * 解析时按 tool_use_id 反向嫁接到对应的 tool_use block。
   */
  presentation?: unknown;
  /**
   * tool_use block：工具执行的结构化事实（exitCode / 字节数 / 耗时 …）。
   * 与 presentation 同一条落盘与嫁接通道，类型同样刻意是 `unknown`——本文件是
   * 不可信边界，权威校验器是 shared 的 `normalizeToolResultMetadata`；公开分享安全活动以 `publicActivityOnly` 标记。
   */
  toolMetadata?: unknown;
  publicActivityOnly?: boolean;
}

export interface ParsedTranscript {
  sessionId?: string;
  blocks: TranscriptBlock[];
  stats: {
    /** Snapshot 内的真实物理行总数。全量解析时也等于本次扫描行数。 */
    lines: number;
    parsedLines: number;
    parseErrors: number;
    /** 窗口解析实际扫描的物理行数；全量兼容路径不返回该字段。 */
    scannedLines?: number;
  };
}

export interface TranscriptWindowTiming {
  indexDurationMs: number;
  readParseDurationMs: number;
}

export interface ParsedTranscriptWindow extends ParsedTranscript {
  window: {
    /** 1-based，空文件为 0。 */
    startLine: number;
    /** inclusive；空文件为 0。 */
    endLine: number;
    totalLines: number;
    startsAtBeginning: boolean;
    endsAtEnd: boolean;
    /** 所有扩窗尝试累计扫描行数（可能大于最终窗口行数）。 */
    totalScannedLines: number;
    /** transcript 最新 block id；before 窗口通过独立的小尾窗获得。 */
    latestCursor?: string;
    /** 当前文件代次；仅用于生成不随 append 漂移的 opaque cursor。 */
    cursorGeneration: string;
    /** opaque/legacy cursor 校验后的真实 block id。 */
    resolvedAfter?: string;
    resolvedBefore?: string;
    /** 文件被截断、替换或 cursor 已损坏时为 true，调用方应回退最新尾页。 */
    cursorInvalidated: boolean;
  };
  timing: TranscriptWindowTiming;
}

export interface ParseTranscriptWindowOptions {
  after?: string;
  before?: string;
  limit: number;
}

/**
 * 会话详情是展示派生视图，不是原始 transcript 的镜像。
 *
 * 原文始终保留在 JSONL / EventStore；这里限制单块展示文本，避免一条超大工具结果在
 * JSON.parse → block.content/raw → JSON.stringify → HTTP body 的链路上被复制数次。
 */
export const TRANSCRIPT_DETAIL_MESSAGE_MAX_CHARS = 512 * 1024;
export const TRANSCRIPT_DETAIL_THINKING_MAX_CHARS = 128 * 1024;
export const TRANSCRIPT_DETAIL_TOOL_INPUT_MAX_CHARS = 64 * 1024;
export const TRANSCRIPT_DETAIL_RAW_MAX_CHARS = 16 * 1024;
export const TRANSCRIPT_DETAIL_META_MAX_CHARS = 16 * 1024;
export const TRANSCRIPT_DETAIL_TOOL_RESULT_MAX_CHARS = 16 * 1024;
export const TRANSCRIPT_DETAIL_OLD_TOOL_RESULT_MAX_CHARS = 4_000;
export const TRANSCRIPT_DETAIL_TOOL_RESULT_KEEP_RECENT = 8;

export const TRANSCRIPT_JSON_PARSE_LINE_THRESHOLD_CHARS = 2 * 1024 * 1024;
export const TRANSCRIPT_STREAM_LINE_PREFIX_CHARS = 64 * 1024;
export const TRANSCRIPT_STREAM_LINE_TAIL_CHARS = 64 * 1024;

const TRANSCRIPT_DETAIL_TRUNCATION_LABEL = "会话详情已截断；原始记录未改动";

function findJsonStringEnd(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === '"') return index;
  }
  return -1;
}

export type BoundedTranscriptLine =
  | { oversized: false; line: string; sourceChars: number }
  | { oversized: true; prefix: string; tail: string; sourceChars: number };

export interface ReadTranscriptLinesBoundedOptions {
  /** UTF-8 文件字节偏移，inclusive；必须落在物理行起点。 */
  start?: number;
  /** UTF-8 文件字节偏移，exclusive；必须落在物理行边界或 snapshot EOF。 */
  end?: number;
}

interface TranscriptLineIndex {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  lineStarts: number[];
  endedWithNewline: boolean;
  tailAnchor: string;
  generation: string;
}

const TRANSCRIPT_WINDOW_CURSOR_PREFIX = 'tw1.';
const transcriptWindowProcessSeed = createHash('sha256')
  .update(`${process.pid}:${Date.now()}:${Math.random()}`)
  .digest('base64url')
  .slice(0, 12);
let transcriptWindowGenerationSequence = 0;

function createTranscriptWindowGeneration(stat: Stats): string {
  transcriptWindowGenerationSequence += 1;
  return `${transcriptWindowProcessSeed}:${stat.dev}:${stat.ino}:${transcriptWindowGenerationSequence}`;
}

export function encodeTranscriptWindowCursor(generation: string, blockId?: string): string | undefined {
  if (!blockId) return undefined;
  return `${TRANSCRIPT_WINDOW_CURSOR_PREFIX}${Buffer.from(JSON.stringify({
    generation,
    blockId,
  })).toString('base64url')}`;
}

function resolveTranscriptWindowCursor(
  cursor: string | undefined,
  generation: string,
): { blockId?: string; invalidated: boolean } {
  if (!cursor) return { invalidated: false };
  if (!cursor.startsWith(TRANSCRIPT_WINDOW_CURSOR_PREFIX)) {
    // 兼容升级前已经落进 IndexedDB 的 line-* cursor。
    return /^line-\d+(?:-|$)/.test(cursor)
      ? { blockId: cursor, invalidated: false }
      : { invalidated: true };
  }
  if (cursor.length > 2_048) return { invalidated: true };
  try {
    const decoded = JSON.parse(Buffer.from(
      cursor.slice(TRANSCRIPT_WINDOW_CURSOR_PREFIX.length),
      'base64url',
    ).toString('utf8')) as { generation?: unknown; blockId?: unknown };
    if (
      decoded.generation !== generation
      || typeof decoded.blockId !== 'string'
      || !/^line-\d+(?:-|$)/.test(decoded.blockId)
    ) {
      return { invalidated: true };
    }
    return { blockId: decoded.blockId, invalidated: false };
  } catch {
    return { invalidated: true };
  }
}

const TRANSCRIPT_LINE_INDEX_MAX_ENTRIES = 128;
const TRANSCRIPT_LINE_INDEX_SCAN_BYTES = 64 * 1024;
const TRANSCRIPT_LINE_INDEX_ANCHOR_BYTES = 256;
const transcriptLineIndexCache = new Map<string, TranscriptLineIndex>();
const transcriptLineIndexInFlight = new Map<string, Promise<TranscriptLineIndex>>();

function rememberTranscriptLineIndex(path: string, index: TranscriptLineIndex): void {
  transcriptLineIndexCache.delete(path);
  transcriptLineIndexCache.set(path, index);
  while (transcriptLineIndexCache.size > TRANSCRIPT_LINE_INDEX_MAX_ENTRIES) {
    const oldest = transcriptLineIndexCache.keys().next().value as string | undefined;
    if (!oldest) break;
    transcriptLineIndexCache.delete(oldest);
  }
}

async function readFileRange(
  handle: FileHandle,
  start: number,
  end: number,
): Promise<Buffer> {
  const length = Math.max(0, end - start);
  if (length === 0) return Buffer.alloc(0);
  const output = Buffer.allocUnsafe(length);
  let written = 0;
  while (written < length) {
    const { bytesRead } = await handle.read(output, written, length - written, start + written);
    if (bytesRead === 0) break;
    written += bytesRead;
  }
  return written === length ? output : output.subarray(0, written);
}

function hashAnchor(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("base64url");
}

async function readTailAnchor(
  handle: FileHandle,
  snapshotSize: number,
): Promise<string> {
  const start = Math.max(0, snapshotSize - TRANSCRIPT_LINE_INDEX_ANCHOR_BYTES);
  return hashAnchor(await readFileRange(handle, start, snapshotSize));
}

async function anchorMatches(
  handle: FileHandle,
  cached: TranscriptLineIndex,
): Promise<boolean> {
  if (cached.size === 0) return true;
  return (await readTailAnchor(handle, cached.size)) === cached.tailAnchor;
}

async function scanLineStarts(
  handle: FileHandle,
  start: number,
  end: number,
  lineStarts: number[],
): Promise<boolean> {
  const buffer = Buffer.allocUnsafe(TRANSCRIPT_LINE_INDEX_SCAN_BYTES);
  let position = start;
  let lastByte = -1;
  while (position < end) {
    const length = Math.min(buffer.length, end - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) break;
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      const nextLineStart = position + index + 1;
      if (nextLineStart < end && lineStarts.at(-1) !== nextLineStart) {
        lineStarts.push(nextLineStart);
      }
    }
    lastByte = buffer[bytesRead - 1] ?? lastByte;
    position += bytesRead;
  }
  return end > start ? lastByte === 0x0a : false;
}

async function buildTranscriptLineIndexUncached(resolved: string): Promise<TranscriptLineIndex> {
  const file = await openTrustedTranscript(resolved);
  const handle = file.handle;
  try {
    const stat = file.stats;
    const dev = Number(stat.dev);
    const ino = Number(stat.ino);
    const size = stat.size;
    const cached = transcriptLineIndexCache.get(resolved);

    if (
      cached
      && cached.dev === dev
      && cached.ino === ino
      && cached.size === size
      && cached.mtimeMs === stat.mtimeMs
    ) {
      rememberTranscriptLineIndex(resolved, cached);
      return cached;
    }

    // 只有身份不变、文件增长且旧 EOF anchor 仍相同时才按 append 增量扩展。
    if (
      cached
      && cached.dev === dev
      && cached.ino === ino
      && size > cached.size
      && await anchorMatches(handle, cached)
    ) {
      const lineStarts = [...cached.lineStarts];
      if (cached.size === 0) lineStarts.push(0);
      else if (cached.endedWithNewline && cached.size < size) lineStarts.push(cached.size);
      const endedWithNewline = await scanLineStarts(handle, cached.size, size, lineStarts);
      const index: TranscriptLineIndex = {
        dev,
        ino,
        size,
        mtimeMs: stat.mtimeMs,
        lineStarts,
        endedWithNewline,
        tailAnchor: await readTailAnchor(handle, size),
        generation: cached.generation,
      };
      rememberTranscriptLineIndex(resolved, index);
      return index;
    }

    // 截断、替换、同尺寸重写和非 append compaction 都走完整重建。
    const lineStarts = size > 0 ? [0] : [];
    const endedWithNewline = await scanLineStarts(handle, 0, size, lineStarts);
    const index: TranscriptLineIndex = {
      dev,
      ino,
      size,
      mtimeMs: stat.mtimeMs,
      lineStarts,
      endedWithNewline,
      tailAnchor: await readTailAnchor(handle, size),
      generation: createTranscriptWindowGeneration(stat),
    };
    rememberTranscriptLineIndex(resolved, index);
    return index;
  } finally {
    await handle.close();
  }
}

async function getTranscriptLineIndex(resolved: string): Promise<TranscriptLineIndex> {
  const existing = transcriptLineIndexInFlight.get(resolved);
  if (existing) return existing;
  const promise = buildTranscriptLineIndexUncached(resolved)
    .finally(() => transcriptLineIndexInFlight.delete(resolved));
  transcriptLineIndexInFlight.set(resolved, promise);
  return promise;
}

function appendBoundedTail(current: string, segment: string): string {
  if (segment.length >= TRANSCRIPT_STREAM_LINE_TAIL_CHARS) {
    return segment.slice(-TRANSCRIPT_STREAM_LINE_TAIL_CHARS);
  }
  const keepCurrent = TRANSCRIPT_STREAM_LINE_TAIL_CHARS - segment.length;
  return `${current.slice(-keepCurrent)}${segment}`;
}

/**
 * 按固定大小 chunk 读取 JSONL。异常大单行只保留头尾窗口，避免 readline 先把整行
 * （生产上曾出现 269,261,793 字符）物化成一个巨型字符串。
 */
export async function* readTranscriptLinesBounded(
  filePath: string,
  options: ReadTranscriptLinesBoundedOptions = {},
): AsyncGenerator<BoundedTranscriptLine> {
  const start = Math.max(0, Math.floor(options.start ?? 0));
  const end = options.end === undefined ? undefined : Math.max(start, Math.floor(options.end));
  if (end !== undefined && end <= start) return;
  const file = await openTrustedTranscript(filePath);
  const input = file.handle.createReadStream({
    encoding: "utf-8",
    autoClose: false,
    highWaterMark: 64 * 1024,
    start,
    ...(end === undefined ? {} : { end: end - 1 }),
  });
  let parts: string[] = [];
  let sourceChars = 0;
  let oversized = false;
  let prefix = "";
  let tail = "";

  const consume = (segment: string) => {
    if (!segment) return;
    sourceChars += segment.length;
    if (!oversized && sourceChars <= TRANSCRIPT_JSON_PARSE_LINE_THRESHOLD_CHARS) {
      parts.push(segment);
      return;
    }
    if (!oversized) {
      oversized = true;
      const retained = parts.join("") + segment;
      prefix = retained.slice(0, TRANSCRIPT_STREAM_LINE_PREFIX_CHARS);
      tail = retained.slice(-TRANSCRIPT_STREAM_LINE_TAIL_CHARS);
      parts = [];
      return;
    }
    tail = appendBoundedTail(tail, segment);
  };

  const finish = (): BoundedTranscriptLine => {
    if (!oversized) {
      const line = parts.join("").replace(/\r$/, "");
      return { oversized: false, line, sourceChars };
    }
    return {
      oversized: true,
      prefix,
      tail: tail.replace(/\r$/, ""),
      sourceChars,
    };
  };

  const reset = () => {
    parts = [];
    sourceChars = 0;
    oversized = false;
    prefix = "";
    tail = "";
  };

  try {
    for await (const chunk of input) {
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf("\n", cursor);
        if (newline < 0) {
          consume(chunk.slice(cursor));
          break;
        }
        consume(chunk.slice(cursor, newline));
        yield finish();
        reset();
        cursor = newline + 1;
      }
    }

    if (sourceChars > 0 || parts.length > 0 || oversized) yield finish();
  } finally {
    input.destroy();
    await file.handle.close().catch(() => undefined);
  }
}

function hasJsonStringField(source: string, name: string, value: string): boolean {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`"${escapedName}"\\s*:\\s*"${escapedValue}"`).test(source);
}

function isEscapedJsonQuote(source: string, quoteIndex: number): boolean {
  let slashCount = 0;
  for (let index = quoteIndex - 1; index >= 0 && source[index] === "\\"; index -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function findLastJsonFieldValueStart(source: string, name: string): number {
  const needle = `"${name}"`;
  let index = source.lastIndexOf(needle);
  while (index >= 0) {
    if (!isEscapedJsonQuote(source, index)) {
      let cursor = index + needle.length;
      while (cursor < source.length && /\s/.test(source[cursor]!)) cursor += 1;
      if (source[cursor] === ":") {
        cursor += 1;
        while (cursor < source.length && /\s/.test(source[cursor]!)) cursor += 1;
        return cursor;
      }
    }
    index = source.lastIndexOf(needle, index - 1);
  }
  return -1;
}

function extractLastJsonNumberField(source: string, name: string): number | undefined {
  const start = findLastJsonFieldValueStart(source, name);
  if (start < 0) return undefined;
  const match = source.slice(start, start + 64).match(/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

function extractLastJsonStringField(source: string, name: string): string | undefined {
  const start = findLastJsonFieldValueStart(source, name);
  if (start < 0 || source[start] !== '"') return undefined;
  const end = findJsonStringEnd(source, start + 1);
  if (end < 0) return undefined;
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function extractLastJsonBooleanField(source: string, name: string): boolean | undefined {
  const start = findLastJsonFieldValueStart(source, name);
  if (start < 0) return undefined;
  if (source.startsWith("true", start)) return true;
  if (source.startsWith("false", start)) return false;
  return undefined;
}

export function truncateTranscriptDetailText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return "";
  const marker = `\n\n...[${TRANSCRIPT_DETAIL_TRUNCATION_LABEL}；省略 ${text.length - maxChars} 字符]...\n\n`;
  if (marker.length >= maxChars) return marker.slice(0, maxChars);
  const available = maxChars - marker.length;
  const head = Math.ceil(available * 0.75);
  const tail = available - head;
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`;
}

function toTsMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** 解析 transcript user 行顶层 attachments 字段（legacyTranscriptProjection userLine 写入） */
function parseUserAttachments(
  value: unknown,
): Array<{ name: string; isImage?: boolean; relativePath?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Array<{ name: string; isImage?: boolean; relativePath?: string }> = [];
  for (const item of value) {
    const name = typeof (item as { name?: unknown })?.name === "string"
      ? (item as { name: string }).name
      : undefined;
    if (!name) continue;
    const relativePath = typeof (item as { relativePath?: unknown })?.relativePath === "string"
      ? (item as { relativePath: string }).relativePath
      : undefined;
    out.push({
      name,
      ...((item as { isImage?: unknown })?.isImage === true ? { isImage: true } : {}),
      ...(relativePath ? { relativePath } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function formatJson(value: unknown, maxChars = TRANSCRIPT_DETAIL_META_MAX_CHARS): string {
  try {
    return truncateTranscriptDetailText(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return truncateTranscriptDetailText(String(value), maxChars);
  }
}

function normalizeTextContent(
  content: unknown,
  maxChars = TRANSCRIPT_DETAIL_MESSAGE_MAX_CHARS,
): string {
  if (typeof content === "string") return truncateTranscriptDetailText(content, maxChars);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const t = (block as any).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    if (parts.length) return truncateTranscriptDetailText(parts.join("\n"), maxChars);
    return formatJson(content, maxChars);
  }
  if (content == null) return "";
  return truncateTranscriptDetailText(String(content), maxChars);
}

/** 剥离 <memory-context>...</memory-context> 前缀，用于前端展示时隐藏记忆内容 */
export function stripMemoryContext(text: string): string {
  return text.replace(/^<memory-context>[\s\S]*?<\/memory-context>\s*/, '');
}

/** 剥离 [YYYY/MM/DD 周X HH:MM] 时间戳前缀，时间信息改由 tsMs 元数据传递（兼容不含星期的旧格式） */
export function stripTimestampPrefix(text: string): string {
  return text.replace(/^\[\d{4}\/\d{2}\/\d{2}\s+(?:周[一二三四五六日]\s+)?\d{2}:\d{2}\]\s*/, '');
}

const VOICE_STT_TAG_RE = /^\[这是一条语音转文字的消息，可能存在识别准确度问题\]\s*/;

/** 判断用户文本是否带有语音转文字标注前缀 */
export function isVoiceSttTagged(text: string): boolean {
  return VOICE_STT_TAG_RE.test(text);
}

/** 从需要纯用户文本的场景中剥离语音转文字标注前缀 */
export function stripVoiceSttTag(text: string): string {
  return text.replace(VOICE_STT_TAG_RE, '');
}

function isSkillContextText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith("Base directory for this skill:")) return true;
  if (t.includes("\n# gog\n") && t.includes("Use `gog`")) return true;
  if (t.includes("ARGUMENTS:") && t.includes("Base directory for this skill:")) return true;
  return false;
}

/** 从用户消息文本中剥离 <task-notification> 块（SDK 后台任务完成通知） */
export function stripTaskNotification(text: string): string {
  return text.replace(/<task-notification>[\s\S]*?<\/task-notification>\s*/g, '');
}

/**
 * 判断用户消息是否为纯 task-notification（没有实际用户文本）。
 * 通知可能带时间戳前缀或 memory-context，剥离后仅剩通知则判为纯通知。
 */
export function isPureTaskNotification(text: string): boolean {
  if (!text.includes("<task-notification>")) return false;
  const remaining = stripTaskNotification(
    stripTimestampPrefix(stripMemoryContext(text.trim()))
  ).trim();
  return remaining === '';
}

/** 从 <task-notification> XML 中提取字段 */
function parseTaskNotification(text: string): {
  taskId?: string;
  toolUseId?: string;
  status?: string;
  summary?: string;
} {
  const tag = (name: string) => {
    const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return m?.[1]?.trim();
  };
  return {
    taskId: tag('task-id'),
    toolUseId: tag('tool-use-id'),
    status: tag('status'),
    summary: tag('summary'),
  };
}

/**
 * 解析 transcript 文件
 */
interface ParseTranscriptRangeOptions {
  start?: number;
  end?: number;
  physicalLineOffset?: number;
  totalLines?: number;
  exposeScannedLines?: boolean;
}

async function parseTranscriptFileUncached(
  resolved: string,
  options: ParseTranscriptRangeOptions = {},
): Promise<ParsedTranscript> {
  const blocks: TranscriptBlock[] = [];
  let lineNumber = options.physicalLineOffset ?? 0;
  let scannedLines = 0;
  let parsedLines = 0;
  let parseErrors = 0;
  let boundedOversizedLines = 0;
  let largestSourceLineChars = 0;
  let sessionId: string | undefined;

  // toolId -> toolName 映射，用于 tool_result 关联
  const toolIdToName: Record<string, string> = {};
  /**
   * tool_use_id → 该 tool_use block 在 blocks 里的下标。
   *
   * presentation 落盘在 tool_result 行（tool_use 行在工具执行前就已写出，
   * 那时还不知道结果），解析时需按此映射反向嫁接回 tool_use block——
   * 前端只在 tool_use 分支读 presentation，配对过的 tool_result 会被丢弃。
   */
  const toolIdToBlockIndex: Record<string, number> = {};
  const recentToolResults: TranscriptBlock[] = [];

  for await (const record of readTranscriptLinesBounded(resolved, options)) {
    lineNumber += 1;
    scannedLines += 1;
    if (record.oversized) {
      boundedOversizedLines += 1;
      largestSourceLineChars = Math.max(largestSourceLineChars, record.sourceChars);
      parsedLines += 1;

      const retained = `${record.prefix}${record.tail}`;
      const tsMs = toTsMs(
        extractLastJsonStringField(record.prefix, "timestamp")
          ?? extractLastJsonStringField(record.prefix, "ts"),
      );
      const retainedSessionId = extractLastJsonStringField(retained, "sessionId")
        ?? extractLastJsonStringField(retained, "session_id");
      if (!sessionId && retainedSessionId) sessionId = retainedSessionId;

      const marker = `${TRANSCRIPT_DETAIL_TRUNCATION_LABEL}（原始单行 ${record.sourceChars} 字符）`;
      const isUser = hasJsonStringField(record.prefix, "type", "user");
      const isAssistant = hasJsonStringField(record.prefix, "type", "assistant");
      const isToolResult = hasJsonStringField(retained, "type", "tool_result");
      const isToolUse = hasJsonStringField(retained, "type", "tool_use");

      if (isUser && isToolResult) {
        const toolUseId = extractLastJsonStringField(retained, "tool_use_id") ?? "unknown";
        blocks.push({
          id: `line-${lineNumber}-oversized-tool-result`,
          tsMs,
          kind: "tool_result",
          title: `工具结果: ${toolUseId}`,
          defaultOpen: false,
          content: marker,
          toolName: toolIdToName[toolUseId],
          toolId: toolUseId,
        });
        continue;
      }

      if (isAssistant && isToolUse) {
        const toolId = extractLastJsonStringField(record.prefix, "id") ?? "";
        const toolName = extractLastJsonStringField(record.prefix, "name") ?? "unknown";
        if (toolId) toolIdToName[toolId] = toolName;
        blocks.push({
          id: `line-${lineNumber}-oversized-tool-use`,
          tsMs,
          kind: "tool_use",
          title: `工具调用: ${toolName}`,
          defaultOpen: false,
          content: marker,
          toolName,
          toolId,
        });
        continue;
      }

      blocks.push({
        id: `line-${lineNumber}-oversized`,
        tsMs,
        kind: isAssistant ? "text" : isUser ? "prompt" : "meta",
        title: isAssistant ? "输出" : isUser ? "输入" : "超大记录",
        defaultOpen: isAssistant || isUser,
        content: marker,
      });
      continue;
    }

    const { line } = record;
    if (!line.trim()) continue;

    let obj: any;
    try {
      obj = JSON.parse(line);
      parsedLines += 1;
    } catch {
      parseErrors += 1;
      blocks.push({
        id: `line-${lineNumber}`,
        kind: "meta",
        title: "Unparseable transcript line",
        defaultOpen: false,
        content: truncateTranscriptDetailText(line, TRANSCRIPT_DETAIL_META_MAX_CHARS),
      });
      continue;
    }

    const tsMs =
      toTsMs(obj?.timestamp) ?? toTsMs(obj?.ts) ?? toTsMs(obj?.startedAtMs);

    if (!sessionId && typeof obj?.sessionId === "string") sessionId = obj.sessionId;
    if (!sessionId && typeof obj?.session_id === "string") sessionId = obj.session_id;

    // Assistant messages
    if (obj?.type === "assistant" && obj?.message?.content) {
      const content = obj.message.content;
      // 门禁拒答合成行的顶层标记（web channel appendGuardrailTranscript 写入）；
      // 透传到 text block → 前端历史重建后申诉按钮拿真实 event id
      const guardrailEventId =
        typeof obj?.guardrailEventId === "string" ? obj.guardrailEventId : undefined;
      const sourceEventId =
        typeof obj?.sourceEventId === "string" ? obj.sourceEventId : undefined;
      const runId = typeof obj?.runId === "string" ? obj.runId : undefined;
      if (Array.isArray(content)) {
        let idx = 0;
        for (const block of content) {
          idx += 1;
          const blockType = block?.type;
          if (blockType === "text") {
            blocks.push({
              id: `line-${lineNumber}-assistant-${idx}`,
              tsMs,
              kind: "text",
              title: "输出",
              defaultOpen: true,
              content: typeof block.text === "string"
                ? truncateTranscriptDetailText(block.text, TRANSCRIPT_DETAIL_MESSAGE_MAX_CHARS)
                : formatJson(block, TRANSCRIPT_DETAIL_MESSAGE_MAX_CHARS),
              ...(sourceEventId ? { sourceEventId } : {}),
              ...(runId ? { runId } : {}),
              ...(guardrailEventId ? { guardrailEventId } : {}),
            });
            continue;
          }
          if (blockType === "thinking" || blockType === "redacted_thinking") {
            const title = blockType === "thinking" ? "思考" : "思考（已脱敏）";
            const thinkingText =
              typeof block?.thinking === "string"
                ? block.thinking
                : typeof block?.text === "string"
                  ? block.text
                  : undefined;
            blocks.push({
              id: `line-${lineNumber}-assistant-${idx}`,
              tsMs,
              kind: "thinking",
              title,
              defaultOpen: true,
              content: truncateTranscriptDetailText(
                thinkingText ?? "(no thinking text)",
                TRANSCRIPT_DETAIL_THINKING_MAX_CHARS,
              ),
              raw: formatJson(block, TRANSCRIPT_DETAIL_RAW_MAX_CHARS),
            });
            continue;
          }
          if (blockType === "tool_use") {
            const toolName = String(block?.name ?? "unknown");
            const toolId = String(block?.id ?? "");
            const maybeSkill = toolName === "Skill" ? block?.input?.skill : undefined;
            const title =
              toolName === "Skill" && typeof maybeSkill === "string" && maybeSkill.trim()
                ? `工具调用：技能（${maybeSkill.trim()}）`
                : `工具调用: ${toolName}`;

            // 记录 toolId -> toolName 映射
            if (toolId) {
              toolIdToName[toolId] = toolName;
              toolIdToBlockIndex[toolId] = blocks.length;
            }

            blocks.push({
              id: `line-${lineNumber}-assistant-${idx}`,
              tsMs,
              kind: "tool_use",
              title,
              defaultOpen: false,
              content: formatJson(block?.input, TRANSCRIPT_DETAIL_TOOL_INPUT_MAX_CHARS),
              raw: formatJson({
                tool_use_id: block?.id,
                name: block?.name,
                input: block?.input,
              }, TRANSCRIPT_DETAIL_RAW_MAX_CHARS),
              toolName,
              toolId, ...(runId ? { runId } : {}),
            });
            continue;
          }

          blocks.push({
            id: `line-${lineNumber}-assistant-${idx}`,
            tsMs,
            kind: "meta",
            title: `Assistant block: ${String(blockType ?? "unknown")}`,
            defaultOpen: false,
            content: formatJson(block, TRANSCRIPT_DETAIL_META_MAX_CHARS),
          });
        }
      } else {
        blocks.push({
          id: `line-${lineNumber}-assistant`,
          tsMs,
          kind: "text",
          title: "输出",
          defaultOpen: true,
          content: normalizeTextContent(content, TRANSCRIPT_DETAIL_MESSAGE_MAX_CHARS),
        });
      }
      continue;
    }

    // User messages
    if (obj?.type === "user" && obj?.message?.content != null) {
      const content = obj.message.content;
      const userAttachments = parseUserAttachments(obj?.attachments);
      const clientMsgId = typeof obj?.clientMsgId === "string" ? obj.clientMsgId : undefined;
      const interjectionSourceRunId = typeof obj?.interjectionSourceRunId === "string"
        ? obj.interjectionSourceRunId
        : undefined;
      let attachmentsAttached = false;
      if (Array.isArray(content)) {
        let idx = 0;
        for (const block of content) {
          idx += 1;
          const blockType = block?.type;
          if (blockType === "tool_result") {
            const isError = block?.is_error === true;
            const toolUseId = String(block?.tool_use_id ?? "");
            const toolName = toolUseId ? (toolIdToName[toolUseId] ?? "unknown") : undefined;
            const toolResultContent = truncateReplayToolResultContent(
              normalizeTextContent(block?.content, TRANSCRIPT_DETAIL_TOOL_INPUT_MAX_CHARS),
              TRANSCRIPT_DETAIL_TOOL_RESULT_MAX_CHARS,
              toolUseId || "unknown",
            );

            // 反向嫁接：presentation 写在 tool_result 行，但要挂到 tool_use block 上。
            // 刻意不写进 raw——raw 的语义是「给模型看的原始 payload」，
            // 混进去会在 debug 视图制造「模型也看到了摘要」的错觉。
            if ((block?.presentation !== undefined || block?.metadata !== undefined) && toolUseId) {
              const target = toolIdToBlockIndex[toolUseId];
              const targetBlock = target === undefined ? undefined : blocks[target];
              if (targetBlock) {
                if (block.presentation !== undefined) targetBlock.presentation = block.presentation;
                if (block.metadata !== undefined) targetBlock.toolMetadata = block.metadata;
              }
            }

            const toolResultBlock: TranscriptBlock = {
              id: `line-${lineNumber}-user-${idx}`,
              tsMs,
              kind: "tool_result",
              title: `工具结果: ${toolUseId || "unknown"}${isError ? "（错误）" : ""}`,
              defaultOpen: false,
              content: toolResultContent,
              raw: formatJson({
                tool_use_id: block?.tool_use_id,
                is_error: block?.is_error,
                content: toolResultContent,
              }, TRANSCRIPT_DETAIL_RAW_MAX_CHARS),
              isError,
              toolName,
              toolId: toolUseId,
            };
            blocks.push(toolResultBlock);
            recentToolResults.push(toolResultBlock);
            if (recentToolResults.length > TRANSCRIPT_DETAIL_TOOL_RESULT_KEEP_RECENT) {
              const older = recentToolResults.shift();
              if (older) {
                older.content = truncateReplayToolResultContent(
                  older.content,
                  TRANSCRIPT_DETAIL_OLD_TOOL_RESULT_MAX_CHARS,
                  older.toolId || "unknown",
                );
                // raw 与 content 重复承载同一工具结果；旧结果保留可见节选即可。
                delete older.raw;
              }
            }
            continue;
          }
          if (blockType === "text") {
            const text = typeof block.text === "string"
              ? truncateTranscriptDetailText(block.text, TRANSCRIPT_DETAIL_MESSAGE_MAX_CHARS)
              : formatJson(block, TRANSCRIPT_DETAIL_MESSAGE_MAX_CHARS);
            if (isSkillContextText(text)) {
              blocks.push({
                id: `line-${lineNumber}-user-${idx}`,
                tsMs,
                kind: "meta",
                title: "技能上下文（自动注入）",
                defaultOpen: false,
                content: text,
              });
              continue;
            }
            if (isPureTaskNotification(text)) {
              const notif = parseTaskNotification(text);
              const statusLabel = notif.status === 'failed'
                ? '失败'
                : notif.status === 'completed'
                  ? '完成'
                  : notif.status === 'cancelled'
                    ? '已取消'
                    : notif.status || '未知';
              blocks.push({
                id: `line-${lineNumber}-user-${idx}`,
                tsMs,
                kind: "tool_use",
                title: `后台任务: ${statusLabel}`,
                defaultOpen: false,
                content: JSON.stringify({ description: notif.summary, status: notif.status }, null, 2),
                toolName: "BackgroundTask",
                toolId: notif.toolUseId || `bg-task-${lineNumber}-${idx}`,
                isError: notif.status === 'failed' || notif.status === 'cancelled',
              });
              continue;
            }
            const strippedText = stripTaskNotification(text);
            const promptText = stripTimestampPrefix(stripMemoryContext(strippedText));
            const isVoiceTranscript = isVoiceSttTagged(promptText);
            // 附件只附到本行第一个 prompt block，避免多 text block 重复展示
            const attachHere = userAttachments && !attachmentsAttached;
            if (attachHere) attachmentsAttached = true;
            blocks.push({
              id: `line-${lineNumber}-user-${idx}`,
              tsMs,
              kind: "prompt",
              title: "输入（Prompt）",
              defaultOpen: true,
              content: stripVoiceSttTag(promptText),
              ...(isVoiceTranscript ? { isVoiceTranscript: true } : {}),
              ...(attachHere ? { attachments: userAttachments } : {}),
              ...(clientMsgId ? { clientMsgId } : {}),
              ...(interjectionSourceRunId ? { interjectionSourceRunId } : {}),
            });
            continue;
          }
          blocks.push({
            id: `line-${lineNumber}-user-${idx}`,
            tsMs,
            kind: "meta",
            title: `User block: ${String(blockType ?? "unknown")}`,
            defaultOpen: false,
            content: formatJson(block, TRANSCRIPT_DETAIL_META_MAX_CHARS),
          });
        }
      } else {
        const text = normalizeTextContent(content, TRANSCRIPT_DETAIL_MESSAGE_MAX_CHARS);
        if (isSkillContextText(text)) {
          blocks.push({
            id: `line-${lineNumber}-user`,
            tsMs,
            kind: "meta",
            title: "技能上下文（自动注入）",
            defaultOpen: false,
            content: text,
          });
          continue;
        }
        if (isPureTaskNotification(text)) {
          const notif = parseTaskNotification(text);
          const statusLabel = notif.status === 'failed'
            ? '失败'
            : notif.status === 'completed'
              ? '完成'
              : notif.status === 'cancelled'
                ? '已取消'
                : notif.status || '未知';
          blocks.push({
            id: `line-${lineNumber}-user`,
            tsMs,
            kind: "tool_use",
            title: `后台任务: ${statusLabel}`,
            defaultOpen: false,
            content: JSON.stringify({ description: notif.summary, status: notif.status }, null, 2),
            toolName: "BackgroundTask",
            toolId: notif.toolUseId || `bg-task-${lineNumber}`,
            isError: notif.status === 'failed' || notif.status === 'cancelled',
          });
          continue;
        }
        const strippedText = stripTaskNotification(text);
        const promptText = stripTimestampPrefix(stripMemoryContext(strippedText));
        const isVoiceTranscript = isVoiceSttTagged(promptText);
        blocks.push({
          id: `line-${lineNumber}-user`,
          tsMs,
          kind: "prompt",
          title: "输入（Prompt）",
          defaultOpen: true,
          content: stripVoiceSttTag(promptText),
          ...(isVoiceTranscript ? { isVoiceTranscript: true } : {}),
          ...(userAttachments ? { attachments: userAttachments } : {}),
          ...(clientMsgId ? { clientMsgId } : {}),
          ...(interjectionSourceRunId ? { interjectionSourceRunId } : {}),
        });
      }
      continue;
    }

    // /compact v2：压缩分界线。content 为摘要正文（前端仅 debugMode 提供展开查看）
    if (obj?.type === "compaction") {
      blocks.push({
        id: `line-${lineNumber}-compaction`,
        tsMs,
        kind: "compaction",
        title: "上下文已压缩",
        defaultOpen: false,
        content: typeof obj?.summary === "string"
          ? truncateTranscriptDetailText(obj.summary, TRANSCRIPT_DETAIL_MESSAGE_MAX_CHARS)
          : "",
        ...(typeof obj?.coveredEventCount === "number"
          ? { coveredEventCount: obj.coveredEventCount }
          : {}),
      });
      continue;
    }

    // SDK result message
    if (obj?.type === "result") {
      blocks.push({
        id: `line-${lineNumber}-result`,
        tsMs,
        kind: "meta",
        title: `结果: ${String(obj?.subtype ?? "unknown")}`,
        defaultOpen: false,
        content: formatJson(obj, TRANSCRIPT_DETAIL_META_MAX_CHARS),
      });
      continue;
    }

    // Everything else
    const label =
      obj?.type && typeof obj.type === "string"
        ? `${obj.type}${obj.subtype ? `:${obj.subtype}` : ""}`
        : "meta";
    blocks.push({
      id: `line-${lineNumber}-meta`,
      tsMs,
      kind: "meta",
      title: label,
      defaultOpen: false,
      content: formatJson(obj, TRANSCRIPT_DETAIL_META_MAX_CHARS),
    });
  }

  if (boundedOversizedLines > 0) {
    apiLogger.warn(
      `[transcript] bounded oversized JSONL lines path=${resolved} count=${boundedOversizedLines} largestSourceLineChars=${largestSourceLineChars}`,
    );
  }

  return {
    sessionId,
    blocks,
    stats: {
      lines: options.totalLines ?? scannedLines,
      parsedLines,
      parseErrors,
      ...(options.exposeScannedLines ? { scannedLines } : {}),
    },
  };
}

/**
 * 快速摘要：提取 title/preview/createdAtMs 用于列表展示
 */
export interface TranscriptSummary {
  title?: string;
  preview?: string;
  createdAtMs?: number;
}

/**
 * 从 prompt 内容中提取标题，跳过钉钉上下文等系统前缀
 */
function extractTitleFromContent(content: string): string {
  let text = stripMemoryContext(content);

  // 钉钉格式: [钉钉消息上下文]...\n[用户消息]\n实际内容
  const userMsgMarker = "[用户消息]";
  const idx = text.indexOf(userMsgMarker);
  if (idx >= 0) {
    text = text.slice(idx + userMsgMarker.length).trim();
  }

  // 剥离 [2026/02/03 周一 22:13] 这类时间戳前缀（兼容不含星期的旧格式）
  text = text.replace(/^\[\d{4}\/\d{2}\/\d{2}\s+(?:周[一二三四五六日]\s+)?\d{2}:\d{2}\]\s*/, "");

  return text.slice(0, 100);
}

// ============================================
// Token usage
// ============================================

export interface TokenUsage {
  /**
   * 最后一轮 provider request 的 total token。
   * 是否可作为“当前上下文”展示，取决于模型 dispatch 口径：
   * full-history 请求可用；Responses previous_response_id 接力不可用。
   */
  contextTokens: number;
  /** 最后一轮 provider request 的 token；full replay 时等于准确当前上下文。 */
  lastRequestTokens: number;
  /** 所有轮次的 input_tokens 累加（OpenAI-compatible 下包含缓存命中部分） */
  totalInputTokens: number;
  /** 所有轮次的 cache_read_input_tokens 累加 */
  totalCacheReadTokens: number;
  /** 所有轮次的 cache_creation_input_tokens 累加 */
  totalCacheCreationTokens: number;
  /** 所有轮次的 output_tokens 累加 */
  totalOutputTokens: number;
  /** 子 agent（Task 工具）的 totalTokens 累加 */
  subagentTotalTokens: number;
  /** 新 Agent 工具的 durable child-session 用量分项（由 sessions stats 路由补充）。 */
  subagentUsage?: {
    childCount: number;
    requestCount: number;
    inputTokens: number;
    uncachedInputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheHitDenominatorTokens: number;
    cacheHitRatio: number | null;
  };
  /** 主 agent 逐轮 total + 子 agent total 的累计 token，用于 UI 展示累计口径 */
  totalTokens: number;
  /** 缓存命中率分母，按模型 accounting_mode 归一化 */
  cacheHitDenominatorTokens: number;
  /** 缓存命中率；无有效分母时为 null */
  cacheHitRatio: number | null;
}

const TOKEN_USAGE_CACHE_MAX_ENTRIES = 128;

interface TokenUsageCacheEntry {
  mtimeMs: number;
  size: number;
  usage: TokenUsage | null;
}

const tokenUsageCache = new Map<string, TokenUsageCacheEntry>();
const tokenUsageInFlight = new Map<string, Promise<TokenUsage | null>>();

function tokenUsageCacheKey(resolved: string, legacyResponseMode?: ModelResponseMode): string {
  return `${resolved}\0${legacyResponseMode ?? ""}`;
}

function getCachedTokenUsage(
  key: string,
  mtimeMs: number,
  size: number,
): TokenUsage | null | undefined {
  const cached = tokenUsageCache.get(key);
  if (!cached) return undefined;
  if (cached.mtimeMs !== mtimeMs || cached.size !== size) {
    tokenUsageCache.delete(key);
    return undefined;
  }
  tokenUsageCache.delete(key);
  tokenUsageCache.set(key, cached);
  return cached.usage;
}

function setCachedTokenUsage(
  key: string,
  mtimeMs: number,
  size: number,
  usage: TokenUsage | null,
): void {
  tokenUsageCache.delete(key);
  tokenUsageCache.set(key, { mtimeMs, size, usage });
  while (tokenUsageCache.size > TOKEN_USAGE_CACHE_MAX_ENTRIES) {
    const oldest = tokenUsageCache.keys().next().value as string | undefined;
    if (!oldest) break;
    tokenUsageCache.delete(oldest);
  }
}

/**
 * 轻量级 token 统计：遍历 jsonl 提取主 agent 和子 agent 的 token 数据。
 *
 * - contextTokens: 复用 ContextTokenAccumulator；新 transcript 以 response_mode
 *   的 full / relay / fallback_full 事实计算，旧 transcript 由调用方按模型配置提供默认值。
 * - totalTokens: 主 agent 每轮 total 累加 + 子 agent total
 * - totalOutputTokens: 所有 turn 的 output_tokens 累加
 * - subagentTotalTokens: user 消息中 toolUseResult.totalTokens 累加（子 agent 消耗）
 *
 * 2026-07-14 起不再从 cache_read 猜接力状态：prompt cache miss 与
 * previous_response_id 是否接力是两件事。新事件写 response_mode；存量事件由 sessions
 * 路由根据模型配置传 legacyResponseMode。只有两者都缺失时才保留旧启发式兼容。
 */
export async function getTokenUsage(
  transcriptPath: string,
  options: { legacyResponseMode?: ModelResponseMode } = {},
): Promise<TokenUsage | null> {
  const { cacheKey: resolved } = trustedTranscriptLocation(transcriptPath);
  const stat = await statTrustedTranscript(resolved);
  const key = tokenUsageCacheKey(resolved, options.legacyResponseMode);
  const cached = getCachedTokenUsage(key, stat.mtimeMs, stat.size);
  if (cached !== undefined) return cached;

  // 活跃会话可能在扫描期间继续追加；同一路径仍只保留一次扫描，避免大文件并行读两份。
  // 本次结果若对应旧 stat，下一次请求会因 mtime/size 不同自动重新计算。
  const existing = tokenUsageInFlight.get(key);
  if (existing) return existing;

  const usagePromise = getTokenUsageUncached(resolved, options)
    .then((usage) => {
      setCachedTokenUsage(key, stat.mtimeMs, stat.size, usage);
      return usage;
    })
    .finally(() => {
      tokenUsageInFlight.delete(key);
    });
  tokenUsageInFlight.set(key, usagePromise);
  return usagePromise;
}

async function getTokenUsageUncached(
  resolved: string,
  options: { legacyResponseMode?: ModelResponseMode },
): Promise<TokenUsage | null> {
  let lastContextTokens = 0;
  let lastRequestTokens = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalOutputTokens = 0;
  let subagentTotalTokens = 0;
  let mainTotalTokens = 0;
  let cacheHitDenominatorTokens = 0;
  let hasUsage = false;
  const contextAccumulator = new ContextTokenAccumulator();

  const applyAssistantUsage = (
    usage: Record<string, unknown>,
    model: string,
    responseMode: ModelResponseMode | undefined,
    responseChained: boolean | undefined,
  ) => {
    hasUsage = true;

    const inp = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const cr = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
    const cc = typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
    const out = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    const turnTotal = computeUsageTotalTokens(model, {
      inputTokens: inp,
      outputTokens: out,
      cacheReadTokens: cr,
      cacheCreationTokens: cc,
    });
    mainTotalTokens += turnTotal;
    if (inp > 0 || out > 0) lastRequestTokens = turnTotal;
    cacheHitDenominatorTokens += computeCacheHitDenominatorTokens(model, {
      inputTokens: inp,
      outputTokens: out,
      cacheReadTokens: cr,
      cacheCreationTokens: cc,
    });

    if (inp > 0 || out > 0) {
      lastContextTokens = contextAccumulator.apply(model, {
        inputTokens: inp,
        outputTokens: out,
        cacheReadInputTokens: cr,
        cacheCreationInputTokens: cc,
      }, responseMode, responseChained);
    }

    totalInputTokens += inp;
    totalCacheReadTokens += cr;
    totalCacheCreationTokens += cc;
    totalOutputTokens += out;
  };

  for await (const record of readTranscriptLinesBounded(resolved)) {
    if (record.oversized) {
      const retained = `${record.prefix}${record.tail}`;
      if (hasJsonStringField(record.prefix, "type", "compaction")) {
        contextAccumulator.reset();
        lastContextTokens = 0;
        continue;
      }
      if (hasJsonStringField(record.prefix, "type", "user")) {
        const totalTokens = extractLastJsonNumberField(retained, "totalTokens");
        if (totalTokens !== undefined) subagentTotalTokens += totalTokens;
        continue;
      }
      if (!hasJsonStringField(record.prefix, "type", "assistant")) continue;

      const inputTokens = extractLastJsonNumberField(retained, "input_tokens");
      const outputTokens = extractLastJsonNumberField(retained, "output_tokens");
      if (inputTokens === undefined && outputTokens === undefined) continue;
      const rawResponseMode = extractLastJsonStringField(retained, "response_mode");
      const responseMode: ModelResponseMode | undefined = rawResponseMode === "full"
        || rawResponseMode === "relay"
        || rawResponseMode === "fallback_full"
        ? rawResponseMode
        : options.legacyResponseMode;
      applyAssistantUsage({
        input_tokens: inputTokens ?? 0,
        output_tokens: outputTokens ?? 0,
        cache_read_input_tokens: extractLastJsonNumberField(retained, "cache_read_input_tokens") ?? 0,
        cache_creation_input_tokens: extractLastJsonNumberField(retained, "cache_creation_input_tokens") ?? 0,
      }, extractLastJsonStringField(retained, "model") ?? "", responseMode,
      extractLastJsonBooleanField(retained, "response_chained"));
      continue;
    }

    const { line } = record;
    if (line.includes('"type":"compaction"')) {
      try {
        const obj = JSON.parse(line);
        if (obj?.type === 'compaction') {
          contextAccumulator.reset();
          lastContextTokens = 0;
          continue;
        }
      } catch {
        // 交给下方常规解析忽略坏行
      }
    }
    // 子 agent 数据在 user 消息的 toolUseResult 中
    if (line.includes('"totalTokens"')) {
      try {
        const obj = JSON.parse(line);
        const tr = obj?.toolUseResult;
        if (tr && typeof tr.totalTokens === "number") {
          subagentTotalTokens += tr.totalTokens;
        }
      } catch {
        // ignore
      }
    }

    // 主 agent 数据在 assistant 消息中
    if (!line.includes('"type":"assistant"')) continue;

    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj?.type !== "assistant") continue;

    const usage = obj?.message?.usage;
    if (!usage || typeof usage !== "object") continue;

    const model = typeof obj?.message?.model === "string" ? obj.message.model : "";
    const rawResponseMode = obj?.message?.response_mode;
    const responseMode: ModelResponseMode | undefined = rawResponseMode === 'full'
      || rawResponseMode === 'relay'
      || rawResponseMode === 'fallback_full'
      ? rawResponseMode
      : options.legacyResponseMode;
    const responseChained = typeof obj?.message?.response_chained === 'boolean'
      ? obj.message.response_chained
      : undefined;
    applyAssistantUsage(usage, model, responseMode, responseChained);
  }

  if (!hasUsage) return null;

  return {
    contextTokens: lastContextTokens,
    lastRequestTokens,
    totalInputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    totalOutputTokens,
    subagentTotalTokens,
    totalTokens: mainTotalTokens + subagentTotalTokens,
    cacheHitDenominatorTokens,
    cacheHitRatio: cacheHitDenominatorTokens > 0 ? totalCacheReadTokens / cacheHitDenominatorTokens : null,
  };
}

// ============================================
// Transcript summary (with in-memory mtime cache)
// ============================================

/** 小文件阈值：低于此值直接全量 readline 扫描 */
const SMALL_FILE_THRESHOLD = 128 * 1024; // 128KB
/** 头部读取字节数（覆盖头部 3-5 行，提取 title + createdAtMs） */
const HEAD_BYTES = 8192; // 8KB
/** 尾部读取字节数（覆盖尾部约 20-30 行，提取最后一条 assistant preview） */
const TAIL_BYTES = 64 * 1024; // 64KB

/**
 * 从头部行中提取 title 和 createdAtMs。
 */
function extractHeadFields(headLines: string[]): { title?: string; createdAtMs?: number } {
  let title: string | undefined;
  let createdAtMs: number | undefined;

  for (const line of headLines) {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (createdAtMs === undefined) {
      const tsMs = toTsMs(obj?.timestamp) ?? toTsMs(obj?.ts) ?? toTsMs(obj?.startedAtMs);
      if (tsMs) createdAtMs = tsMs;
    }

    if (title === undefined && obj?.type === "user" && obj?.message?.content != null) {
      const content = obj.message.content;
      if (typeof content === "string" && !isSkillContextText(content)) {
        title = extractTitleFromContent(content);
      } else if (Array.isArray(content)) {
        const textBlock = content.find((b: any) => b?.type === "text");
        if (textBlock && typeof textBlock.text === "string" && !isSkillContextText(textBlock.text)) {
          title = extractTitleFromContent(textBlock.text);
        }
      }
    }

    if (createdAtMs !== undefined && title !== undefined) break;
  }

  return { title, createdAtMs };
}

/**
 * 从尾部行中反向查找最后一条 assistant 消息的文本作为 preview。
 */
function extractLastAssistantPreview(tailLines: string[]): string | undefined {
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    // 快速字符串预筛，跳过非 assistant 行
    if (!line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')) {
      continue;
    }

    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj?.type !== "assistant" || !obj?.message?.content) continue;

    const content = obj.message.content;
    if (typeof content === "string") {
      return content.slice(0, 200);
    }
    if (Array.isArray(content)) {
      const textBlock = content.find((b: any) => b?.type === "text");
      if (textBlock && typeof textBlock.text === "string") {
        return textBlock.text.slice(0, 200);
      }
    }
  }

  return undefined;
}

/** 大文件：并行读取头部和尾部 */
async function summarizeLargeFile(filePath: string, fileSize: number): Promise<TranscriptSummary> {
  const [headLines, tailLines] = await Promise.all([
    readTrustedTranscriptHeadLines(filePath, HEAD_BYTES),
    readTrustedTranscriptTailLines(filePath, fileSize, TAIL_BYTES),
  ]);

  const { title, createdAtMs } = extractHeadFields(headLines);
  const preview = extractLastAssistantPreview(tailLines);

  return { title, preview, createdAtMs };
}

/** 小文件：全量 readline 扫描（原逻辑） */
async function summarizeFullScan(filePath: string): Promise<TranscriptSummary> {
  let title: string | undefined;
  let createdAtMs: number | undefined;
  let lastAssistantText: string | undefined;
  let isFirstUserPrompt = true;

  const file = await openTrustedTranscript(filePath);
  const input = file.handle.createReadStream({ encoding: "utf-8", autoClose: false });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
    if (!line.trim()) continue;

    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const tsMs = toTsMs(obj?.timestamp) ?? toTsMs(obj?.ts) ?? toTsMs(obj?.startedAtMs);
    if (!createdAtMs && tsMs) createdAtMs = tsMs;

    if (isFirstUserPrompt && obj?.type === "user" && obj?.message?.content != null) {
      const content = obj.message.content;
      if (typeof content === "string" && !isSkillContextText(content)) {
        title = extractTitleFromContent(content);
        isFirstUserPrompt = false;
      } else if (Array.isArray(content)) {
        const textBlock = content.find((b: any) => b?.type === "text");
        if (textBlock && typeof textBlock.text === "string" && !isSkillContextText(textBlock.text)) {
          title = extractTitleFromContent(textBlock.text);
          isFirstUserPrompt = false;
        }
      }
    }

    if (obj?.type === "assistant" && obj?.message?.content) {
      const content = obj.message.content;
      if (typeof content === "string") {
        lastAssistantText = content;
      } else if (Array.isArray(content)) {
        const textBlock = content.find((b: any) => b?.type === "text");
        if (textBlock && typeof textBlock.text === "string") {
          lastAssistantText = textBlock.text;
        }
      }
    }
  }
  } finally {
    rl.close();
    input.destroy();
    await file.handle.close().catch(() => undefined);
  }

  const preview = lastAssistantText?.slice(0, 200);
  return { title, preview, createdAtMs };
}

const summaryCache = new Map<string, { mtimeMs: number; summary: TranscriptSummary }>();
const TRANSCRIPT_PARSE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const TRANSCRIPT_PARSE_CACHE_MAX_ENTRIES = 32;

interface TranscriptParseCacheEntry {
  mtimeMs: number;
  parsed: ParsedTranscript;
  estimatedBytes: number;
}

const transcriptParseCache = new Map<string, TranscriptParseCacheEntry>();
let transcriptParseCacheBytes = 0;
const transcriptParseInFlight = new Map<string, Promise<ParsedTranscript>>();

function estimateParsedTranscriptBytes(parsed: ParsedTranscript): number {
  let chars = parsed.sessionId?.length ?? 0;
  for (const block of parsed.blocks) {
    chars += block.id.length + block.title.length + block.content.length;
    chars += block.raw?.length ?? 0;
    chars += block.toolName?.length ?? 0;
    chars += block.toolId?.length ?? 0;
    if (block.presentation !== undefined) {
      try {
        chars += JSON.stringify(block.presentation).length;
      } catch {
        chars += 1024;
      }
    }
    if (block.toolMetadata !== undefined) {
      try {
        chars += JSON.stringify(block.toolMetadata).length;
      } catch {
        chars += 256;
      }
    }
  }
  // V8 字符串通常按 1 或 2 bytes/char 存储；按 2 倍保守估算并计对象开销。
  return chars * 2 + parsed.blocks.length * 512;
}

function deleteTranscriptParseCacheEntry(key: string): void {
  const existing = transcriptParseCache.get(key);
  if (!existing) return;
  transcriptParseCache.delete(key);
  transcriptParseCacheBytes = Math.max(0, transcriptParseCacheBytes - existing.estimatedBytes);
}

function getCachedTranscript(resolved: string, mtimeMs: number): ParsedTranscript | undefined {
  const cached = transcriptParseCache.get(resolved);
  if (!cached) return undefined;
  if (cached.mtimeMs !== mtimeMs) {
    // 活跃会话 mtime 变化时先释放旧快照，再解析新版本，避免两份大对象叠峰。
    deleteTranscriptParseCacheEntry(resolved);
    return undefined;
  }
  // Map 插入顺序作为 LRU；命中后移到尾部。
  transcriptParseCache.delete(resolved);
  transcriptParseCache.set(resolved, cached);
  return cached.parsed;
}

function setCachedTranscript(resolved: string, mtimeMs: number, parsed: ParsedTranscript): void {
  deleteTranscriptParseCacheEntry(resolved);
  const estimatedBytes = estimateParsedTranscriptBytes(parsed);
  if (estimatedBytes > TRANSCRIPT_PARSE_CACHE_MAX_BYTES) {
    apiLogger.warn(
      `[transcript] detail cache bypass path=${resolved} estimatedBytes=${estimatedBytes}`,
    );
    return;
  }
  transcriptParseCache.set(resolved, { mtimeMs, parsed, estimatedBytes });
  transcriptParseCacheBytes += estimatedBytes;
  while (
    transcriptParseCache.size > TRANSCRIPT_PARSE_CACHE_MAX_ENTRIES
    || transcriptParseCacheBytes > TRANSCRIPT_PARSE_CACHE_MAX_BYTES
  ) {
    const oldest = transcriptParseCache.keys().next().value as string | undefined;
    if (!oldest) break;
    deleteTranscriptParseCacheEntry(oldest);
  }
}

export async function summarizeTranscript(
  transcriptPath: string,
): Promise<TranscriptSummary> {
  const { cacheKey: resolved } = trustedTranscriptLocation(transcriptPath);
  const stat = await statTrustedTranscript(resolved);

  // 命中缓存：mtime 未变则直接返回
  const cached = summaryCache.get(resolved);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.summary;
  }

  const summary = stat.size > SMALL_FILE_THRESHOLD
    ? await summarizeLargeFile(resolved, stat.size)
    : await summarizeFullScan(resolved);

  summaryCache.set(resolved, { mtimeMs: stat.mtimeMs, summary });
  return summary;
}

function transcriptCursorLine(cursor: string | undefined): number | undefined {
  if (!cursor) return undefined;
  const match = /^line-(\d+)(?:-|$)/.exec(cursor);
  if (!match) return undefined;
  const line = Number(match[1]);
  return Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

async function transcriptIndexSnapshotStillValid(
  resolved: string,
  index: TranscriptLineIndex,
): Promise<boolean> {
  const file = await openTrustedTranscript(resolved);
  const handle = file.handle;
  try {
    const stat = file.stats;
    if (Number(stat.dev) !== index.dev || Number(stat.ino) !== index.ino) return false;
    if (stat.size < index.size) return false;
    if (stat.size === index.size) return stat.mtimeMs === index.mtimeMs;
    return anchorMatches(handle, index);
  } finally {
    await handle.close();
  }
}

/**
 * 只解析会话详情分页所需的连续物理行窗。索引仅驻留进程内存，不创建 sidecar，
 * 并把读取上界固定在索引 snapshot EOF；并发 append 会留给下一次请求。
 */
export async function parseTranscriptWindow(
  transcriptPath: string,
  options: ParseTranscriptWindowOptions,
): Promise<ParsedTranscriptWindow> {
  const { cacheKey: resolved } = trustedTranscriptLocation(transcriptPath);
  const limit = Math.max(1, Math.floor(options.limit));

  // 路径在建索引和范围读取之间被 replace/compact 时重试一次；游标失效本身不抛错。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const indexStartedAt = Date.now();
    const index = await getTranscriptLineIndex(resolved);
    const indexDurationMs = Date.now() - indexStartedAt;
    const totalLines = index.lineStarts.length;
    let totalScannedLines = 0;
    let readParseDurationMs = 0;

    const parseRange = async (startLine: number, endLine: number): Promise<ParsedTranscript> => {
      if (totalLines === 0 || endLine < startLine) {
        return {
          blocks: [],
          stats: { lines: totalLines, parsedLines: 0, parseErrors: 0, scannedLines: 0 },
        };
      }
      const boundedStart = Math.max(1, Math.min(totalLines, startLine));
      const boundedEnd = Math.max(boundedStart, Math.min(totalLines, endLine));
      const start = index.lineStarts[boundedStart - 1]!;
      const end = boundedEnd < totalLines ? index.lineStarts[boundedEnd]! : index.size;
      const startedAt = Date.now();
      const parsed = await parseTranscriptFileUncached(resolved, {
        start,
        end,
        physicalLineOffset: boundedStart - 1,
        totalLines,
        exposeScannedLines: true,
      });
      readParseDurationMs += Date.now() - startedAt;
      totalScannedLines += parsed.stats.scannedLines ?? 0;
      return parsed;
    };

    const parseTail = async (wantedBlocks: number): Promise<{ parsed: ParsedTranscript; startLine: number }> => {
      if (totalLines === 0) return { parsed: await parseRange(1, 0), startLine: 0 };
      let span = Math.max(32, wantedBlocks);
      let startLine = Math.max(1, totalLines - span + 1);
      let parsed = await parseRange(startLine, totalLines);
      while (parsed.blocks.length < wantedBlocks && startLine > 1) {
        span *= 2;
        startLine = Math.max(1, totalLines - span + 1);
        parsed = await parseRange(startLine, totalLines);
      }
      return { parsed, startLine };
    };

    let parsed: ParsedTranscript;
    let startLine: number;
    let endLine: number;
    let latestCursor: string | undefined;
    const afterCursor = resolveTranscriptWindowCursor(options.after, index.generation);
    const beforeCursor = resolveTranscriptWindowCursor(options.before, index.generation);
    const resolvedAfter = afterCursor.blockId;
    const resolvedBefore = beforeCursor.blockId;
    const cursorInvalidated = afterCursor.invalidated || beforeCursor.invalidated;
    const afterLine = transcriptCursorLine(resolvedAfter);
    const beforeLine = transcriptCursorLine(resolvedBefore);

    if (resolvedBefore && beforeLine && beforeLine <= totalLines) {
      // 保留边界后的少量物理行，让 tool_result 仍可把 presentation 嫁接回
      // before 附近的 tool_use；payload 最终仍只返回 before 之前的 blocks。
      endLine = Math.min(totalLines, beforeLine + 32);
      let span = Math.max(32, limit + 1);
      startLine = Math.max(1, beforeLine - span + 1);
      parsed = await parseRange(startLine, endLine);
      let beforeIndex = parsed.blocks.findIndex((block) => block.id === resolvedBefore);
      while (beforeIndex >= 0 && beforeIndex < limit && startLine > 1) {
        span *= 2;
        startLine = Math.max(1, beforeLine - span + 1);
        parsed = await parseRange(startLine, endLine);
        beforeIndex = parsed.blocks.findIndex((block) => block.id === resolvedBefore);
      }
      if (beforeIndex < 0) {
        const tail = await parseTail(limit);
        parsed = tail.parsed;
        startLine = tail.startLine;
        endLine = totalLines;
      } else if (endLine < totalLines) {
        latestCursor = (await parseTail(1)).parsed.blocks.at(-1)?.id;
      }
    } else if (
      resolvedAfter
      && afterLine
      && afterLine <= totalLines
      && totalLines - afterLine <= limit
    ) {
      endLine = totalLines;
      let span = 32;
      startLine = Math.max(1, afterLine - span + 1);
      parsed = await parseRange(startLine, endLine);
      let afterIndex = parsed.blocks.findIndex((block) => block.id === resolvedAfter);
      while (afterIndex >= 0 && afterIndex < 31 && startLine > 1) {
        span *= 2;
        startLine = Math.max(1, afterLine - span + 1);
        parsed = await parseRange(startLine, endLine);
        afterIndex = parsed.blocks.findIndex((block) => block.id === resolvedAfter);
      }
      if (afterIndex < 0) {
        const tail = await parseTail(limit);
        parsed = tail.parsed;
        startLine = tail.startLine;
      }
    } else {
      const tail = await parseTail(limit);
      parsed = tail.parsed;
      startLine = tail.startLine;
      endLine = totalLines;
    }

    latestCursor ??= endLine === totalLines ? parsed.blocks.at(-1)?.id : undefined;
    if (await transcriptIndexSnapshotStillValid(resolved, index)) {
      return {
        ...parsed,
        stats: {
          ...parsed.stats,
          lines: totalLines,
          scannedLines: parsed.stats.scannedLines ?? 0,
        },
        window: {
          startLine,
          endLine,
          totalLines,
          startsAtBeginning: totalLines === 0 || startLine === 1,
          endsAtEnd: totalLines === 0 || endLine === totalLines,
          totalScannedLines,
          ...(latestCursor ? { latestCursor } : {}),
          cursorGeneration: index.generation,
          ...(resolvedAfter ? { resolvedAfter } : {}),
          ...(resolvedBefore ? { resolvedBefore } : {}),
          cursorInvalidated,
        },
        timing: { indexDurationMs, readParseDurationMs },
      };
    }
    transcriptLineIndexCache.delete(resolved);
  }

  // 极端持续 rewrite 下用最新索引再做一次尾窗，仍返回可用最新页而不是 500。
  transcriptLineIndexCache.delete(resolved);
  const indexStartedAt = Date.now();
  const index = await getTranscriptLineIndex(resolved);
  const indexDurationMs = Date.now() - indexStartedAt;
  const totalLines = index.lineStarts.length;
  const startLine = totalLines === 0 ? 0 : Math.max(1, totalLines - Math.max(32, limit * 2) + 1);
  const startedAt = Date.now();
  const parsed = totalLines === 0
    ? { blocks: [], stats: { lines: 0, parsedLines: 0, parseErrors: 0, scannedLines: 0 } }
    : await parseTranscriptFileUncached(resolved, {
      start: index.lineStarts[startLine - 1],
      end: index.size,
      physicalLineOffset: startLine - 1,
      totalLines,
      exposeScannedLines: true,
    });
  const readParseDurationMs = Date.now() - startedAt;
  return {
    ...parsed,
    window: {
      startLine,
      endLine: totalLines,
      totalLines,
      startsAtBeginning: totalLines === 0 || startLine === 1,
      endsAtEnd: true,
      totalScannedLines: parsed.stats.scannedLines ?? 0,
      ...(parsed.blocks.at(-1)?.id ? { latestCursor: parsed.blocks.at(-1)!.id } : {}),
      cursorGeneration: index.generation,
      cursorInvalidated: Boolean(options.after || options.before),
    },
    timing: { indexDurationMs, readParseDurationMs },
  };
}

export async function parseTranscriptFile(
  transcriptPath: string,
): Promise<ParsedTranscript> {
  const { cacheKey: resolved } = trustedTranscriptLocation(transcriptPath);
  const stat = await statTrustedTranscript(resolved);

  const cached = getCachedTranscript(resolved, stat.mtimeMs);
  if (cached) {
    apiLogger.info(`[transcript] detail cache hit path=${resolved}`);
    return cached;
  }

  const existing = transcriptParseInFlight.get(resolved);
  if (existing) {
    apiLogger.info(`[transcript] detail singleflight join path=${resolved}`);
    return existing;
  }

  const startedAt = Date.now();
  const parsePromise = parseTranscriptFileUncached(resolved)
    .then((parsed) => {
      setCachedTranscript(resolved, stat.mtimeMs, parsed);
      const durationMs = Date.now() - startedAt;
      apiLogger.info(`[transcript] detail cache miss path=${resolved} duration=${durationMs}ms blocks=${parsed.blocks.length} lines=${parsed.stats.lines}`);
      return parsed;
    })
    .finally(() => {
      transcriptParseInFlight.delete(resolved);
    });

  transcriptParseInFlight.set(resolved, parsePromise);
  return parsePromise;
}
