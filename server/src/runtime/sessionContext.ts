import { z } from 'zod';

import { loadToolDescription } from '../agent/tools/descriptionLoader.js';
import { boundSessionEventList } from './eventContentBudget.js';
import type { AuthorizedToolCall, ToolCallContext, ToolDescriptor, ToolProvider, ToolResult } from '../agent/toolRuntime.js';
import {
  INTERNAL_MODEL_DIAGNOSTIC_EVENT_TYPES,
  isInternalModelDiagnosticEvent,
  type EventListPage,
  type EventStore,
  type PlatformEvent,
} from './types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_SEARCH_RESULTS = 50;
const TRACE_DEFAULT_LINE_COUNT = 50;
const TRACE_MAX_LINE_COUNT = 200;
const TRACE_DEFAULT_CHAR_COUNT = 5_000;
const TRACE_MAX_CHAR_COUNT = 6_000;
const TRACE_DEFAULT_MATCHES = 8;
const TRACE_MAX_MATCHES = 20;
const TRACE_DEFAULT_CONTEXT_LINES = 1;
const TRACE_MAX_CONTEXT_LINES = 3;
const TRACE_SEARCH_SNIPPET_MAX_CHARS = 800;
const TRACE_SEARCH_TOTAL_SNIPPET_CHARS = 5_000;

export interface EventQuery {
  afterCursor?: string;
  limit?: number;
  runId?: string;
  type?: PlatformEvent['type'];
}

export interface SearchOptions {
  limit?: number;
  runId?: string;
  type?: PlatformEvent['type'];
}

export interface ToolTraceReadOptions {
  startLine?: number;
  lineCount?: number;
  startChar?: number;
  charCount?: number;
  query?: string;
  maxMatches?: number;
  contextLines?: number;
}

/**
 * Session-as-context read model over the durable runtime event log.
 *
 * This service deliberately treats summaries, prompts, and UI projections as disposable views:
 * every method reads the append-only EventStore source of truth and returns raw PlatformEvents.
 */
export class SessionContextService {
  constructor(
    private readonly eventStore: EventStore,
    private readonly tenantId: string,
  ) {}

  async getEvents(sessionId: string, opts: EventQuery = {}): Promise<EventListPage> {
    if (isInternalDiagnosticType(opts.type)) return { events: [], hasMore: false };
    const limit = clampLimit(opts.limit, DEFAULT_LIMIT, MAX_LIMIT);
    if (this.eventStore.listPage) {
      const page = await this.eventStore.listPage(this.tenantId, sessionId, {
        afterCursor: opts.afterCursor,
        limit,
        ...(opts.runId ? { runId: opts.runId } : {}),
        ...(opts.type ? { type: opts.type } : {}),
        excludeTypes: [...INTERNAL_MODEL_DIAGNOSTIC_EVENT_TYPES],
      });
      return { ...page, events: page.events.filter((event) => !isInternalModelDiagnosticEvent(event)) };
    }

    const all = await this.eventStore.list(this.tenantId, sessionId);
    const filtered = filterEvents(all, opts).filter((event) => !isInternalModelDiagnosticEvent(event));
    return fallbackPage(filtered, opts.afterCursor, limit);
  }

  async getEventsAround(sessionId: string, eventId: string, before: number, after: number): Promise<PlatformEvent[]> {
    if (this.eventStore.listAround) {
      return (await this.eventStore.listAround(this.tenantId, sessionId, eventId, { before, after }))
        .filter((event) => !isInternalModelDiagnosticEvent(event));
    }
    const events = await this.eventStore.list(this.tenantId, sessionId);
    const index = events.findIndex((event) => event.id === eventId);
    if (index < 0) return [];
    const start = Math.max(0, index - Math.max(0, before));
    const end = Math.min(events.length, index + Math.max(0, after) + 1);
    return events.slice(start, end).filter((event) => !isInternalModelDiagnosticEvent(event));
  }

  async getRunEvents(sessionId: string, runId: string): Promise<PlatformEvent[]> {
    if (this.eventStore.listByRun) {
      return (await this.eventStore.listByRun(this.tenantId, sessionId, runId))
        .filter((event) => !isInternalModelDiagnosticEvent(event));
    }
    return (await this.eventStore.list(this.tenantId, sessionId)).filter((event) => (
      !isInternalModelDiagnosticEvent(event) && 'runId' in event && event.runId === runId
    ));
  }

  async getToolTrace(sessionId: string, toolCallId: string): Promise<PlatformEvent[]> {
    if (this.eventStore.listByToolCall) return this.eventStore.listByToolCall(this.tenantId, sessionId, toolCallId);
    return (await this.eventStore.list(this.tenantId, sessionId)).filter((event) => eventReferencesToolCall(event, toolCallId));
  }

  async readToolTrace(
    sessionId: string,
    toolCallId: string,
    options: ToolTraceReadOptions = {},
  ): Promise<Record<string, unknown>> {
    const events = await this.getToolTrace(sessionId, toolCallId);
    const result = events.find((event): event is Extract<PlatformEvent, { type: 'tool_result' }> => (
      event.type === 'tool_result' && event.toolCallId === toolCallId
    ));
    if (!result) {
      return {
        found: false,
        toolCallId,
        eventTypes: events.map((event) => event.type),
      };
    }

    const document = buildTraceDocument(result.content);
    const base = {
      found: true,
      toolCallId,
      toolName: result.toolName,
      isError: result.isError === true,
      totalLines: document.lines.length,
      totalChars: document.totalChars,
    };
    if (options.query?.trim()) {
      return {
        ...base,
        ...searchTraceDocument(document, options.query, {
          maxMatches: clampInteger(options.maxMatches, TRACE_DEFAULT_MATCHES, 1, TRACE_MAX_MATCHES),
          contextLines: clampInteger(
            options.contextLines,
            TRACE_DEFAULT_CONTEXT_LINES,
            0,
            TRACE_MAX_CONTEXT_LINES,
          ),
        }),
      };
    }
    if (options.startChar !== undefined) {
      return {
        ...base,
        ...readTraceChars(
          result.content,
          document,
          clampInteger(options.startChar, 1, 1, Math.max(1, document.totalChars)),
          clampInteger(options.charCount, TRACE_DEFAULT_CHAR_COUNT, 1, TRACE_MAX_CHAR_COUNT),
        ),
      };
    }
    const startLine = clampInteger(options.startLine, 1, 1, Math.max(1, document.lines.length));
    return {
      ...base,
      ...readTraceLines(
        document,
        startLine,
        clampInteger(options.lineCount, TRACE_DEFAULT_LINE_COUNT, 1, TRACE_MAX_LINE_COUNT),
      ),
    };
  }

  async searchEvents(sessionId: string, query: string, opts: SearchOptions = {}): Promise<PlatformEvent[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const limit = clampLimit(opts.limit, DEFAULT_LIMIT, MAX_SEARCH_RESULTS);
    if (this.eventStore.search) {
      return (await this.eventStore.search(this.tenantId, sessionId, query, {
        limit,
        ...(opts.runId ? { runId: opts.runId } : {}),
        ...(opts.type ? { type: opts.type } : {}),
        excludeTypes: [...INTERNAL_MODEL_DIAGNOSTIC_EVENT_TYPES],
      })).filter((event) => !isInternalModelDiagnosticEvent(event));
    }
    const filtered = filterEvents(await this.eventStore.list(this.tenantId, sessionId), opts);
    return filtered
      .filter((event) => !isInternalModelDiagnosticEvent(event))
      .filter((event) => JSON.stringify(event).toLowerCase().includes(needle))
      .slice(0, limit);
  }
}

function isInternalDiagnosticType(type: PlatformEvent['type'] | undefined): boolean {
  if (!type) return false;
  return type === 'model_request_started'
    || type === 'model_request_checkpoint'
    || type === 'model_request_finished';
}

type SessionGetEventsInput = {
  afterCursor?: string;
  limit?: number;
  runId?: string;
  type?: PlatformEvent['type'];
};

type SessionSearchEventsInput = {
  query: string;
  limit?: number;
  runId?: string;
  type?: PlatformEvent['type'];
};

type SessionGetToolTraceInput = {
  toolCallId: string;
};

/**
 * 2026-08-03 工具面收敛批次：SessionGetEvents/SessionSearchEvents/SessionGetToolTrace
 * 合并为 SessionContext(action=events|search|trace)。三个 action 均为只读 safe，
 * 常开（不随上下文阈值增删——同会话工具面必须稳定以保 prompt prefix 缓存），
 * context governor 超阈值时把本工具设为唯一可用工具。
 */
type SessionContextInput = {
  action: 'events' | 'search' | 'trace';
  afterCursor?: string;
  limit?: number;
  runId?: string;
  type?: PlatformEvent['type'];
  query?: string;
  toolCallId?: string;
  startLine?: number;
  lineCount?: number;
  startChar?: number;
  charCount?: number;
  maxMatches?: number;
  contextLines?: number;
};

const sessionContextSchema = z.object({
  action: z.enum(['events', 'search', 'trace']).describe('events = 按时间顺序分页读取本会话历史事件；search = 按关键词搜索本会话历史事件；trace = 按 toolCallId 获取某次工具调用的完整输入输出。'),
  afterCursor: z.string().optional().describe('events 专用：上次返回的 nextCursor，续读下一页。'),
  limit: z.number().int().positive().max(MAX_LIMIT).optional().describe('返回条数上限（events 最多 200，search 最多 50，超出自动收窄）。'),
  runId: z.string().optional().describe('events/search 可选：只看某个 run 的事件。'),
  type: z.string().optional().describe('events/search 可选：只看某类事件。'),
  query: z.string().max(512).optional().describe('search 必填；trace 可选：在指定 toolCallId 的完整工具结果中定位关键词，返回命中行号、字符位置与上下文片段。'),
  toolCallId: z.string().optional().describe('trace 必填：工具调用 id。'),
  startLine: z.number().int().positive().optional().describe('trace 行读取模式：从第几行开始（1-based）。'),
  lineCount: z.number().int().positive().max(TRACE_MAX_LINE_COUNT).optional().describe('trace 行读取模式：最多读取多少行；默认 50，最多 200，仍受单次字符预算约束。'),
  startChar: z.number().int().positive().optional().describe('trace 字符读取模式：从第几个 Unicode 字符开始（1-based），适合超长单行 JSON。'),
  charCount: z.number().int().positive().max(TRACE_MAX_CHAR_COUNT).optional().describe('trace 字符读取模式：最多读取多少字符；默认 5000，最多 6000。'),
  maxMatches: z.number().int().positive().max(TRACE_MAX_MATCHES).optional().describe('trace 关键字模式：最多返回多少处命中，默认 8、最多 20。'),
  contextLines: z.number().int().min(0).max(TRACE_MAX_CONTEXT_LINES).optional().describe('trace 关键字模式：命中行前后各附带多少行上下文，默认 1、最多 3。'),
});

export const sessionContextToolDescriptor: ToolDescriptor<SessionContextInput> = {
  id: 'SessionContext',
  name: 'SessionContext',
  displayName: 'Session Context',
  description: loadToolDescription('SessionContext'),
  schema: sessionContextSchema,
  risk: 'safe',
  approvalMode: 'never',
  concurrency: 'parallel',
  auditCategory: 'session.context',
  category: 'session',
  label: '会话历史检索',
};

export class SessionToolProvider implements ToolProvider {
  constructor(private readonly contextService: SessionContextService) {}

  list(): ToolDescriptor[] {
    return [sessionContextToolDescriptor];
  }

  async invoke(call: AuthorizedToolCall, context: ToolCallContext): Promise<ToolResult | undefined> {
    if (call.toolId !== sessionContextToolDescriptor.id) return undefined;
    const sessionId = context.workspace.sessionId;
    if (!sessionId) throw new Error('Session context tools require workspace.sessionId.');

    const input = normalizeSessionContextInput(sessionContextSchema.parse(call.input) as SessionContextInput);
    if (input.action === 'events') {
      const opts: SessionGetEventsInput = {
        ...(input.afterCursor !== undefined ? { afterCursor: input.afterCursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
      };
      const page = await this.contextService.getEvents(sessionId, opts);
      return {
        content: JSON.stringify(
          { ...page, events: boundSessionEventList(page.events) },
          null,
          2,
        ),
      };
    }
    if (input.action === 'search') {
      if (!input.query) throw new Error('SessionContext(action="search") 需要 query。');
      const opts: SessionSearchEventsInput = {
        query: input.query,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
      };
      return {
        content: JSON.stringify(
          boundSessionEventList(await this.contextService.searchEvents(sessionId, opts.query, opts)),
          null,
          2,
        ),
      };
    }
    // action === 'trace'
    if (!input.toolCallId) throw new Error('SessionContext(action="trace") 需要 toolCallId。');
    return {
      content: JSON.stringify(await this.contextService.readToolTrace(sessionId, input.toolCallId, {
        ...(input.startLine !== undefined ? { startLine: input.startLine } : {}),
        ...(input.lineCount !== undefined ? { lineCount: input.lineCount } : {}),
        ...(input.startChar !== undefined ? { startChar: input.startChar } : {}),
        ...(input.charCount !== undefined ? { charCount: input.charCount } : {}),
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches } : {}),
        ...(input.contextLines !== undefined ? { contextLines: input.contextLines } : {}),
      }), null, 2),
    };
  }
}

function normalizeSessionContextInput(input: SessionContextInput): SessionContextInput {
  const normalized: SessionContextInput = {
    ...input,
    afterCursor: nonEmptyString(input.afterCursor),
    runId: nonEmptyString(input.runId),
    type: nonEmptyString(input.type) as PlatformEvent['type'] | undefined,
    query: nonEmptyString(input.query),
    toolCallId: nonEmptyString(input.toolCallId),
  };
  if (input.action !== 'trace') return normalized;
  if (normalized.query) {
    return { action: 'trace', toolCallId: normalized.toolCallId, query: normalized.query, maxMatches: input.maxMatches, contextLines: input.contextLines };
  }
  if (input.startLine !== undefined) {
    return { action: 'trace', toolCallId: normalized.toolCallId, startLine: input.startLine, lineCount: input.lineCount };
  }
  if (input.startChar !== undefined) {
    return { action: 'trace', toolCallId: normalized.toolCallId, startChar: input.startChar, charCount: input.charCount };
  }
  return { action: 'trace', toolCallId: normalized.toolCallId };
}

function nonEmptyString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function filterEvents(events: PlatformEvent[], opts: { runId?: string; type?: PlatformEvent['type'] }): PlatformEvent[] {
  return events.filter((event) => {
    if (opts.runId && (!('runId' in event) || event.runId !== opts.runId)) return false;
    if (opts.type && event.type !== opts.type) return false;
    return true;
  });
}

function eventReferencesToolCall(event: PlatformEvent, toolCallId: string): boolean {
  if ('toolCallId' in event && event.toolCallId === toolCallId) return true;
  return event.type === 'assistant_tool_calls' && event.toolCalls.some((call) => call.id === toolCallId);
}

function fallbackPage(events: PlatformEvent[], afterCursor: string | undefined, limit: number): EventListPage {
  const offset = parseCursor(afterCursor);
  const page = events.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    events: page,
    ...(nextOffset < events.length ? { nextCursor: String(nextOffset) } : {}),
    hasMore: nextOffset < events.length,
  };
}

function parseCursor(cursor?: string): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!value || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

interface TraceDocument {
  lines: string[];
  lineStartChars: number[];
  totalChars: number;
}

function buildTraceDocument(content: string): TraceDocument {
  const lines = content.split('\n');
  const lineStartChars: number[] = [];
  let nextStartChar = 1;
  for (const line of lines) {
    lineStartChars.push(nextStartChar);
    nextStartChar += codePointLength(line) + 1;
  }
  return {
    lines,
    lineStartChars,
    totalChars: Math.max(0, nextStartChar - 2),
  };
}

function readTraceLines(
  document: TraceDocument,
  startLine: number,
  requestedLineCount: number,
): Record<string, unknown> {
  const requestedEndLine = Math.min(document.lines.length, startLine + requestedLineCount - 1);
  const selected: string[] = [];
  let usedChars = 0;
  let endLine = startLine - 1;
  for (let lineNumber = startLine; lineNumber <= requestedEndLine; lineNumber += 1) {
    const line = document.lines[lineNumber - 1] ?? '';
    const separatorChars = selected.length > 0 ? 1 : 0;
    const lineChars = codePointLength(line);
    if (usedChars + separatorChars + lineChars > TRACE_DEFAULT_CHAR_COUNT) {
      if (selected.length === 0) {
        const content = takeCodePoints(line, TRACE_DEFAULT_CHAR_COUNT);
        const nextStartChar = (document.lineStartChars[lineNumber - 1] ?? 1) + codePointLength(content);
        return {
          mode: 'lines',
          startLine: lineNumber,
          endLine: lineNumber,
          content,
          lineContentTruncated: true,
          hasMore: nextStartChar <= document.totalChars,
          nextStartChar,
        };
      }
      break;
    }
    selected.push(line);
    usedChars += separatorChars + lineChars;
    endLine = lineNumber;
  }
  const hasMore = endLine < document.lines.length;
  return {
    mode: 'lines',
    startLine,
    endLine,
    content: selected.join('\n'),
    hasMore,
    ...(hasMore ? { nextStartLine: endLine + 1 } : {}),
  };
}

function readTraceChars(
  content: string,
  document: TraceDocument,
  startChar: number,
  charCount: number,
): Record<string, unknown> {
  const chunk = sliceCodePoints(content, startChar - 1, charCount);
  const endChar = startChar + codePointLength(chunk) - 1;
  const hasMore = endChar < document.totalChars;
  return {
    mode: 'characters',
    startChar,
    endChar,
    startLine: lineAtChar(document, startChar),
    endLine: lineAtChar(document, Math.max(startChar, endChar)),
    content: chunk,
    hasMore,
    ...(hasMore ? { nextStartChar: endChar + 1 } : {}),
  };
}

function searchTraceDocument(
  document: TraceDocument,
  query: string,
  options: { maxMatches: number; contextLines: number },
): Record<string, unknown> {
  const normalizedQuery = query.trim();
  const needle = normalizedQuery.toLocaleLowerCase();
  const matches: Array<Record<string, unknown>> = [];
  let snippetChars = 0;
  let totalMatches = 0;
  let stoppedByBudget = false;

  for (let lineIndex = 0; lineIndex < document.lines.length; lineIndex += 1) {
    const line = document.lines[lineIndex] ?? '';
    const lowered = line.toLocaleLowerCase();
    let searchFrom = 0;
    while (searchFrom <= lowered.length) {
      const matchIndex = lowered.indexOf(needle, searchFrom);
      if (matchIndex < 0) break;
      totalMatches += 1;
      if (matches.length < options.maxMatches && !stoppedByBudget) {
        const matchText = line.slice(matchIndex, matchIndex + normalizedQuery.length);
        const matchStartChar = (document.lineStartChars[lineIndex] ?? 1)
          + codePointLength(line.slice(0, matchIndex));
        const matchEndChar = matchStartChar + Math.max(0, codePointLength(matchText) - 1);
        const contextStartLine = Math.max(1, lineIndex + 1 - options.contextLines);
        const contextEndLine = Math.min(document.lines.length, lineIndex + 1 + options.contextLines);
        const contextText = document.lines.slice(contextStartLine - 1, contextEndLine).join('\n');
        const contextStartChar = document.lineStartChars[contextStartLine - 1] ?? 1;
        const matchOffset = matchStartChar - contextStartChar;
        const snippet = sliceAroundMatch(
          contextText,
          matchOffset,
          Math.max(1, codePointLength(matchText)),
          TRACE_SEARCH_SNIPPET_MAX_CHARS,
        );
        if (snippetChars + codePointLength(snippet.content) > TRACE_SEARCH_TOTAL_SNIPPET_CHARS) {
          stoppedByBudget = true;
        } else {
          snippetChars += codePointLength(snippet.content);
          matches.push({
            line: lineIndex + 1,
            startChar: matchStartChar,
            endChar: matchEndChar,
            contextStartLine,
            contextEndLine,
            snippetStartChar: contextStartChar + snippet.startOffset,
            snippet: snippet.content,
          });
        }
      }
      searchFrom = matchIndex + Math.max(1, normalizedQuery.length);
    }
  }

  return {
    mode: 'search',
    query: normalizedQuery,
    matches,
    returnedMatches: matches.length,
    totalMatches,
    hasMore: totalMatches > matches.length,
    ...(stoppedByBudget ? { stoppedByBudget: true } : {}),
  };
}

function sliceAroundMatch(
  value: string,
  matchOffset: number,
  matchLength: number,
  maxChars: number,
): { content: string; startOffset: number } {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return { content: value, startOffset: 0 };
  const before = Math.floor((maxChars - Math.min(matchLength, maxChars)) / 2);
  const startOffset = Math.max(0, Math.min(matchOffset - before, chars.length - maxChars));
  return { content: chars.slice(startOffset, startOffset + maxChars).join(''), startOffset };
}

function sliceCodePoints(value: string, startOffset: number, count: number): string {
  if (count <= 0) return '';
  const result: string[] = [];
  let offset = 0;
  for (const char of value) {
    if (offset >= startOffset && result.length < count) result.push(char);
    offset += 1;
    if (result.length >= count) break;
  }
  return result.join('');
}

function takeCodePoints(value: string, count: number): string {
  return sliceCodePoints(value, 0, count);
}

function codePointLength(value: string): number {
  let length = 0;
  for (const _char of value) length += 1;
  return length;
}

function lineAtChar(document: TraceDocument, charPosition: number): number {
  let low = 0;
  let high = document.lineStartChars.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = document.lineStartChars[middle] ?? 1;
    if (start <= charPosition) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(1, high + 1);
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
