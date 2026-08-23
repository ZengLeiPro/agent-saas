import type {
  DwsChatMessage,
  DwsContextClient,
  DwsMinutesContent,
  DwsMinutesRecord,
  DwsPage,
  DwsWikiDocument,
  DwsWikiDocumentBody,
} from './ports.js';
import type { ContextSyncScope, ContextSyncWindow } from './types.js';

export interface DwsCliExecutionContext {
  tenantId: string;
  accountId: string;
  profileId: string;
  operation: 'chat.list' | 'wiki.list' | 'wiki.read' | 'minutes.list' | 'minutes.summary' | 'minutes.transcript';
  [key: string]: unknown;
}

/**
 * Transport supplied by upper wiring. It must execute the argv through the
 * authenticated user DWS environment (normally ACS) and return parsed JSON.
 * This module deliberately does not spawn DWS or resolve vault secrets itself.
 */
export interface DwsCliJsonExecutor {
  json(
    args: readonly string[],
    execution: {
      env?: Readonly<Record<string, string>>;
      context: DwsCliExecutionContext;
    },
  ): Promise<unknown>;
}

export interface DwsCliContextClientOptions {
  executor: DwsCliJsonExecutor;
  resolveExecution?: (scope: ContextSyncScope) => Promise<{
    env?: Readonly<Record<string, string>>;
    context?: Readonly<Record<string, unknown>>;
  }> | {
    env?: Readonly<Record<string, string>>;
    context?: Readonly<Record<string, unknown>>;
  };
  logger?: {
    warn(message: string, detail?: Readonly<Record<string, unknown>>): void;
  };
  maxTranscriptPages?: number;
  maxTranscriptCharacters?: number;
}

const DEFAULT_MAX_TRANSCRIPT_PAGES = 1_000;
const DEFAULT_MAX_TRANSCRIPT_CHARACTERS = 100_000;

/** Deterministic argv builder/parser for the real DWS v1.0.55 read commands. */
export class DwsCliContextClient implements DwsContextClient {
  private readonly maxTranscriptPages: number;
  private readonly maxTranscriptCharacters: number;

  constructor(private readonly options: DwsCliContextClientOptions) {
    this.maxTranscriptPages = positiveInteger(options.maxTranscriptPages, DEFAULT_MAX_TRANSCRIPT_PAGES);
    this.maxTranscriptCharacters = positiveInteger(
      options.maxTranscriptCharacters,
      DEFAULT_MAX_TRANSCRIPT_CHARACTERS,
    );
  }

  async listChatMessages(input: {
    scope: ContextSyncScope;
    window: ContextSyncWindow;
    cursor?: string;
    pageSize: number;
    conversationId?: string;
  }): Promise<DwsPage<DwsChatMessage>> {
    const args = withProfile([
      'dws', 'chat', 'message', 'list-all',
      '--start', dwsDateTime(input.window.from),
      '--end', dwsDateTime(input.window.to),
      '--limit', String(input.pageSize),
      '--cursor', input.cursor ?? '0',
    ], input.scope.profileId);
    const payload = await this.execute(args, input.scope, 'chat.list');
    const page = parsePage(payload, ['items', 'messages', 'list', 'records']);
    const items = page.items
      .map(parseChatMessage)
      .filter((item): item is DwsChatMessage => Boolean(item))
      .filter(item => !input.conversationId || item.conversationId === input.conversationId);
    return pageResult(items, page);
  }

  async listWikiDocuments(input: {
    scope: ContextSyncScope;
    window: ContextSyncWindow;
    cursor?: string;
    pageSize: number;
  }): Promise<DwsPage<DwsWikiDocument>> {
    // DWS currently exposes creation-time filters but no update-time feed. A
    // bounded creation window would permanently miss edits to older documents,
    // so Phase 1 deliberately performs a complete paginated inventory scan.
    const args = withProfile([
      'dws', 'doc', '+search',
      '--limit', String(Math.min(input.pageSize, 30)),
      ...(input.cursor ? ['--cursor', input.cursor] : []),
    ], input.scope.profileId);
    const payload = await this.execute(args, input.scope, 'wiki.list');
    const page = parsePage(payload, ['items', 'documents', 'nodes', 'list', 'records']);
    const items = page.items
      .map(parseWikiDocument)
      .filter((item): item is DwsWikiDocument => Boolean(item));
    // Inventory reconciliation must never treat an unparseable upstream item as
    // a confirmed deletion. Mark the page incomplete so the window is retried.
    return pageResult(items, {
      ...page,
      truncated: page.truncated || items.length !== page.items.length,
    });
  }

  async getWikiDocumentBody(input: {
    scope: ContextSyncScope;
    documentId: string;
  }): Promise<DwsWikiDocumentBody> {
    const args = withProfile([
      'dws', 'doc', 'read', '--node', input.documentId, '--content-format', 'markdown',
    ], input.scope.profileId);
    const payload = await this.execute(args, input.scope, 'wiki.read');
    if (typeof payload === 'string') return { content: payload };
    const record = payloadRecord(payload);
    return {
      content: contentField(record, ['content', 'markdown', 'text', 'body']),
      ...(optionalString(record, ['format', 'contentFormat', 'content_format'])
        ? { format: optionalString(record, ['format', 'contentFormat', 'content_format']) } : {}),
      ...(optionalTimestamp(record, ['updatedAt', 'modifiedAt', 'gmtModified', 'updateTime'])
        ? { updatedAt: optionalTimestamp(record, ['updatedAt', 'modifiedAt', 'gmtModified', 'updateTime']) } : {}),
      ...(truncatedField(record) ? { truncated: true } : {}),
    };
  }

  async listMinutes(input: {
    scope: ContextSyncScope;
    window: ContextSyncWindow;
    cursor?: string;
    pageSize: number;
  }): Promise<DwsPage<DwsMinutesRecord>> {
    const args = withProfile([
      'dws', 'minutes', '+list-all', '--limit', String(input.pageSize),
      ...(input.cursor ? ['--cursor', input.cursor] : []),
    ], input.scope.profileId);
    const payload = await this.execute(args, input.scope, 'minutes.list');
    const page = parsePage(payload, ['items', 'minutes', 'tasks', 'list', 'records']);
    const from = Date.parse(input.window.from);
    const to = Date.parse(input.window.to);
    const items = page.items
      .map(parseMinutesRecord)
      .filter((item): item is DwsMinutesRecord => Boolean(item))
      .filter(item => {
        const timestamp = Date.parse(item.updatedAt ?? item.startedAt);
        return timestamp >= from && timestamp < to;
      });
    return pageResult(items, page);
  }

  async getMinutesSummary(input: {
    scope: ContextSyncScope;
    minutesId: string;
  }): Promise<DwsMinutesContent> {
    const args = withProfile([
      'dws', 'minutes', 'get', 'summary', '--id', input.minutesId,
    ], input.scope.profileId);
    const payload = await this.execute(args, input.scope, 'minutes.summary');
    if (typeof payload === 'string') return { content: payload };
    const record = payloadRecord(payload);
    return {
      content: contentField(record, ['content', 'summary', 'markdown', 'text']),
      ...(truncatedField(record) ? { truncated: true } : {}),
    };
  }

  async getMinutesTranscript(input: {
    scope: ContextSyncScope;
    minutesId: string;
  }): Promise<DwsMinutesContent> {
    const chunks: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let characters = 0;
    let truncated = false;

    while (true) {
      if (pages >= this.maxTranscriptPages) {
        truncated = true;
        break;
      }
      const args = withProfile([
        'dws', 'minutes', 'get', 'transcription', '--id', input.minutesId, '--direction', '0',
        ...(cursor ? ['--cursor', cursor] : []),
      ], input.scope.profileId);
      const payload = await this.execute(args, input.scope, 'minutes.transcript');
      const page = parsePage(payload, ['items', 'paragraphs', 'sentences', 'transcriptions', 'records']);
      const chunk = transcriptContent(payload, page.items);
      const chunkCharacters = Array.from(chunk).length;
      if (characters + chunkCharacters > this.maxTranscriptCharacters) {
        const remaining = Math.max(0, this.maxTranscriptCharacters - characters);
        chunks.push(Array.from(chunk).slice(0, remaining).join(''));
        truncated = true;
        break;
      }
      if (chunk) chunks.push(chunk);
      characters += chunkCharacters;
      pages += 1;
      truncated ||= page.truncated;
      if (!page.nextCursor) break;
      if (seen.has(page.nextCursor) || page.nextCursor === cursor) {
        truncated = true;
        break;
      }
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    return { content: chunks.filter(Boolean).join('\n'), ...(truncated ? { truncated: true } : {}) };
  }

  private async execute(
    args: readonly string[],
    scope: ContextSyncScope,
    operation: DwsCliExecutionContext['operation'],
  ): Promise<unknown> {
    let resolved: {
      env?: Readonly<Record<string, string>>;
      context?: Readonly<Record<string, unknown>>;
    } = {};
    try {
      resolved = await this.options.resolveExecution?.(scope) ?? {};
      const context: DwsCliExecutionContext = {
        ...resolved.context,
        tenantId: scope.tenantId,
        accountId: scope.accountId,
        profileId: scope.profileId,
        operation,
      };
      return await this.options.executor.json(args, {
        ...(resolved.env ? { env: resolved.env } : {}),
        context,
      });
    } catch (error) {
      const safeError = redactError(error, resolved.env);
      // Never log env, parsed payloads, or credential-bearing executor errors.
      this.options.logger?.warn('DWS context command failed', { operation, args: [...args], error: safeError });
      throw new Error(safeError);
    }
  }
}

interface ParsedPage {
  items: unknown[];
  nextCursor?: string;
  truncated: boolean;
}

function parsePage(payload: unknown, itemKeys: string[]): ParsedPage {
  if (Array.isArray(payload)) return { items: payload, truncated: false };
  const records = objectCandidates(payload);
  const container = records.find(record => itemKeys.some(key => Array.isArray(record[key]))) ?? records[0] ?? {};
  const items = itemKeys.map(key => container[key]).find(Array.isArray) as unknown[] | undefined;
  const hasMore = optionalBoolean(container, ['hasMore', 'has_more', 'more']);
  const nextCursor = optionalString(container, [
    'nextCursor', 'next_cursor', 'nextPageToken', 'next_page_token', 'pageToken',
  ]);
  return {
    items: items ?? [],
    ...(hasMore === false ? {} : nextCursor ? { nextCursor } : {}),
    truncated: truncatedField(container) || (hasMore === true && !nextCursor),
  };
}

function pageResult<T>(items: T[], page: ParsedPage): DwsPage<T> {
  return {
    items,
    ...(!page.truncated && page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(page.truncated ? { truncated: true } : {}),
  };
}

function parseChatMessage(value: unknown): DwsChatMessage | null {
  const record = asRecord(value);
  const messageId = optionalString(record, ['messageId', 'msgId', 'message_id', 'msg_id', 'id']);
  const conversationId = optionalString(record, [
    'conversationId', 'conversation_id', 'openConversationId', 'open_conversation_id', 'cid',
  ]);
  const createdAt = optionalTimestamp(record, ['createdAt', 'createTime', 'create_time', 'sendTime', 'timestamp']);
  if (!messageId || !conversationId || !createdAt) return null;
  return {
    messageId,
    conversationId,
    text: contentField(record, ['text', 'content', 'message', 'body']),
    createdAt,
    ...(optionalTimestamp(record, ['updatedAt', 'updateTime', 'modifiedAt'])
      ? { updatedAt: optionalTimestamp(record, ['updatedAt', 'updateTime', 'modifiedAt']) } : {}),
    ...(optionalString(record, ['senderId', 'sender_id', 'senderUserId', 'sender_user_id'])
      ? { senderId: optionalString(record, ['senderId', 'sender_id', 'senderUserId', 'sender_user_id']) } : {}),
    ...(optionalString(record, ['url', 'messageUrl']) ? { url: optionalString(record, ['url', 'messageUrl']) } : {}),
    ...(truncatedField(record) ? { truncated: true } : {}),
  };
}

function parseWikiDocument(value: unknown): DwsWikiDocument | null {
  const record = asRecord(value);
  const documentId = optionalString(record, ['documentId', 'docId', 'nodeId', 'node_id', 'token', 'id']);
  const title = optionalString(record, ['title', 'name', 'fileName', 'file_name']);
  const updatedAt = optionalTimestamp(record, [
    'updatedAt', 'modifiedAt', 'gmtModified', 'updateTime', 'modifiedTime', 'createdAt', 'createTime',
  ]);
  if (!documentId || !title || !updatedAt) return null;
  return {
    documentId,
    title,
    updatedAt,
    ...(optionalTimestamp(record, ['createdAt', 'createTime', 'createdTime', 'gmtCreate'])
      ? { createdAt: optionalTimestamp(record, ['createdAt', 'createTime', 'createdTime', 'gmtCreate']) } : {}),
    ...(optionalString(record, ['spaceId', 'workspaceId', 'workspace_id'])
      ? { spaceId: optionalString(record, ['spaceId', 'workspaceId', 'workspace_id']) } : {}),
    ...(optionalString(record, ['url', 'link']) ? { url: optionalString(record, ['url', 'link']) } : {}),
  };
}

function parseMinutesRecord(value: unknown): DwsMinutesRecord | null {
  const record = asRecord(value);
  const minutesId = optionalString(record, ['minutesId', 'taskUuid', 'task_uuid', 'taskId', 'id']);
  const title = optionalString(record, ['title', 'subject', 'name']) ?? '未命名听记';
  const startedAt = optionalTimestamp(record, [
    'startedAt', 'startTime', 'start_time', 'createTime', 'createdAt', 'gmtCreate',
  ]);
  if (!minutesId || !startedAt) return null;
  const duration = optionalNumber(record, ['durationSeconds', 'duration', 'duration_seconds']);
  return {
    minutesId,
    title,
    startedAt,
    ...(optionalTimestamp(record, ['updatedAt', 'updateTime', 'modifiedAt', 'gmtModified'])
      ? { updatedAt: optionalTimestamp(record, ['updatedAt', 'updateTime', 'modifiedAt', 'gmtModified']) } : {}),
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
    ...(optionalString(record, ['url', 'link']) ? { url: optionalString(record, ['url', 'link']) } : {}),
  };
}

function transcriptContent(payload: unknown, items: unknown[]): string {
  if (items.length > 0) {
    return items.map(item => {
      const record = asRecord(item);
      const text = contentField(record, ['text', 'content', 'sentence', 'transcription']);
      const speaker = optionalString(record, ['speakerName', 'speaker_name', 'speaker']);
      return speaker && text ? `${speaker}: ${text}` : text;
    }).filter(Boolean).join('\n');
  }
  if (typeof payload === 'string') return payload;
  return contentField(payloadRecord(payload), ['content', 'transcript', 'transcription', 'text']);
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return objectCandidates(payload)[0] ?? {};
}

function objectCandidates(payload: unknown): Record<string, unknown>[] {
  const root = asRecord(payload);
  const candidates: Record<string, unknown>[] = [];
  for (const value of [root.data, root.result, root.response, root]) {
    if (value && typeof value === 'object' && !Array.isArray(value)) candidates.push(value as Record<string, unknown>);
  }
  return candidates;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function contentField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const nested = asRecord(value);
      const text = optionalString(nested, ['text', 'content', 'markdown']);
      if (text) return text;
    }
  }
  return '';
}

function optionalString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) return String(value).trim();
  }
  return undefined;
}

function optionalNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function optionalBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) if (typeof record[key] === 'boolean') return record[key] as boolean;
  return undefined;
}

function optionalTimestamp(record: Record<string, unknown>, keys: string[]): string | undefined {
  const value = keys.map(key => record[key]).find(candidate => typeof candidate === 'string' || typeof candidate === 'number');
  if (value === undefined) return undefined;
  const numeric = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : undefined;
  const millis = numeric === undefined ? Date.parse(String(value)) : numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

function truncatedField(record: Record<string, unknown>): boolean {
  return optionalBoolean(record, ['truncated', 'isTruncated', 'is_truncated', 'incomplete']) === true;
}

function withProfile(args: string[], profileId: string): string[] {
  return [...args, '--profile', profileId, '--format', 'json'];
}

function dwsDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('DWS context command received an invalid timestamp');
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function redactError(error: unknown, env?: Readonly<Record<string, string>>): string {
  let text = error instanceof Error ? error.message : String(error);
  for (const secret of Object.values(env ?? {})) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|client_secret|authorization|token)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || 'DWS context command failed';
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}
