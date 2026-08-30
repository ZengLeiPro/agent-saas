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

const MAX_WIKI_SPACE_PAGES = 100;
const MAX_WIKI_DEPTH = 4;
const MAX_WIKI_NODES_PER_SPACE = 500;
const MAX_WIKI_DOCUMENTS = 10_000;
const READABLE_WIKI_EXTENSIONS = new Set(['', 'adoc', 'amd', 'md', 'adocx']);

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
  beforeExecute?: () => Promise<void>;
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
const MAX_MINUTES_LIST_PAGES = 100;

/** Deterministic argv builder/parser for the pinned DWS v1.0.60 command contracts. */
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
    conversationIds?: readonly string[];
  }): Promise<DwsPage<DwsChatMessage>> {
    const args = withProfile([
      'dws', 'chat', 'message', 'list-all',
      '--start', dwsDateTime(input.window.from),
      '--end', dwsDateTime(input.window.to),
      '--limit', String(input.pageSize),
      '--cursor', input.cursor ?? '0',
    ], input.scope.profileId);
    const payload = await this.execute(args, input.scope, 'chat.list');
    const page = parsePage(payload, ['conversationMessagesList', 'items', 'messages', 'list', 'records']);
    const selected = input.conversationIds ? new Set(input.conversationIds) : undefined;
    const items: DwsChatMessage[] = [];
    let unreadable = false;
    for (const raw of page.items) {
      const container = asRecord(raw);
      const nestedMessages = Array.isArray(container.messages) ? container.messages : undefined;
      const candidates = nestedMessages ?? [raw];
      const inheritedConversationId = chatConversationId(raw);
      for (const candidate of candidates) {
        const rawConversationId = chatConversationId(candidate) ?? inheritedConversationId;
        const addressed = (!input.conversationId || rawConversationId === input.conversationId)
          && (!selected || (rawConversationId ? selected.has(rawConversationId) : true));
        if (!addressed) continue;
        const item = parseChatMessage(candidate, rawConversationId);
        if (!item) {
          unreadable = true;
          continue;
        }
        items.push(item);
      }
    }
    return pageResult(items, { ...page, truncated: page.truncated || unreadable });
  }

  async listWikiDocuments(input: {
    scope: ContextSyncScope;
    window: ContextSyncWindow;
    cursor?: string;
    pageSize: number;
  }): Promise<DwsPage<DwsWikiDocument>> {
    // Wiki deletion reconciliation is safe only against a complete space/node
    // inventory. `doc +search` is merely a recent-access view and must never be
    // used as deletion truth.
    const spaces: string[] = [];
    const seenSpaceCursors = new Set<string>();
    let spaceCursor: string | undefined;
    let truncated = false;
    for (let pageNumber = 0; pageNumber < MAX_WIKI_SPACE_PAGES; pageNumber += 1) {
      const payload = await this.execute(withProfile([
        'dws', 'wiki', 'space', 'list',
        ...(spaceCursor ? ['--cursor', spaceCursor] : []),
      ], input.scope.profileId), input.scope, 'wiki.list');
      const page = parsePage(payload, ['wikiSpaces', 'wiki_spaces', 'spaces', 'items']);
      for (const raw of page.items) {
        const spaceId = optionalString(asRecord(raw), ['workspaceId', 'workspace_id', 'spaceId', 'space_id', 'id']);
        if (!spaceId) truncated = true;
        else spaces.push(spaceId);
      }
      truncated ||= page.truncated;
      if (!page.nextCursor) break;
      if (seenSpaceCursors.has(page.nextCursor) || page.nextCursor === spaceCursor) {
        truncated = true;
        break;
      }
      seenSpaceCursors.add(page.nextCursor);
      spaceCursor = page.nextCursor;
      if (pageNumber === MAX_WIKI_SPACE_PAGES - 1) truncated = true;
    }

    const items: DwsWikiDocument[] = [];
    for (const spaceId of [...new Set(spaces)].sort()) {
      const queue: Array<{ folder?: string; depth: number }> = [{ depth: 0 }];
      const seenFolders = new Set<string>();
      let visited = 0;
      while (queue.length > 0) {
        const next = queue.shift()!;
        if (visited >= MAX_WIKI_NODES_PER_SPACE || items.length >= MAX_WIKI_DOCUMENTS) {
          truncated = true;
          break;
        }
        let nodeCursor: string | undefined;
        const seenNodeCursors = new Set<string>();
        for (let pageNumber = 0; pageNumber < MAX_WIKI_NODES_PER_SPACE; pageNumber += 1) {
          const payload = await this.execute(withProfile([
            'dws', 'wiki', 'node', 'list', '--workspace', spaceId,
            ...(next.folder ? ['--folder', next.folder] : []),
            ...(nodeCursor ? ['--cursor', nodeCursor] : []),
          ], input.scope.profileId), input.scope, 'wiki.list');
          const page = parsePage(payload, ['nodes', 'items']);
          truncated ||= page.truncated;
          for (const raw of page.items) {
            visited += 1;
            if (visited > MAX_WIKI_NODES_PER_SPACE || items.length >= MAX_WIKI_DOCUMENTS) {
              truncated = true;
              break;
            }
            if (isWikiFolder(raw)) {
              const folderId = optionalString(asRecord(raw), ['nodeId', 'node_id', 'id']);
              if (!folderId) {
                truncated = true;
              } else if (next.depth + 1 < MAX_WIKI_DEPTH && !seenFolders.has(folderId)) {
                seenFolders.add(folderId);
                queue.push({ folder: folderId, depth: next.depth + 1 });
              } else if (next.depth + 1 >= MAX_WIKI_DEPTH) {
                truncated = true;
              }
              continue;
            }
            const document = parseWikiDocument(raw);
            if (!document) truncated = true;
            else items.push({ ...document, spaceId });
          }
          if (visited >= MAX_WIKI_NODES_PER_SPACE || items.length >= MAX_WIKI_DOCUMENTS) {
            // Hitting a defensive cap is incomplete even when it lands exactly on
            // a page boundary; otherwise a hidden next page could trigger revoke.
            truncated = true;
            break;
          }
          if (!page.nextCursor) break;
          if (seenNodeCursors.has(page.nextCursor) || page.nextCursor === nodeCursor) {
            truncated = true;
            break;
          }
          seenNodeCursors.add(page.nextCursor);
          nodeCursor = page.nextCursor;
          if (pageNumber === MAX_WIKI_NODES_PER_SPACE - 1) truncated = true;
        }
      }
      if (items.length >= MAX_WIKI_DOCUMENTS) break;
    }
    return { items, ...(truncated ? { truncated: true } : {}) };
  }

  async getWikiDocumentBody(input: {
    scope: ContextSyncScope;
    documentId: string;
    extension?: string;
  }): Promise<DwsWikiDocumentBody> {
    if (!READABLE_WIKI_EXTENSIONS.has((input.extension ?? '').toLowerCase())) {
      return {
        content: '', format: 'metadata-only', unreadable: true, unreadableReason: 'unsupported_format',
      };
    }
    const args = withProfile([
      'dws', 'doc', 'read', '--node', input.documentId, '--content-format', 'markdown',
    ], input.scope.profileId);
    const payload = await this.execute(args, input.scope, 'wiki.read');
    if (typeof payload === 'string') return { content: payload };
    const record = payloadRecord(payload);
    const content = contentField(record, ['content', 'markdown', 'text', 'body']);
    return {
      content,
      ...(!content ? { unreadable: true, unreadableReason: 'body_unavailable' } : {}),
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
    // v1.0.60 的完整 accessible 查询不接受 cursor。若这里带 cursor，只可能是升级前
    // 持久化的失败窗口；从头重读并依赖存储幂等去重，才能让旧重试状态自动收敛。
    const args = withProfile([
      'dws', 'minutes', '+list-all', '--limit', String(input.pageSize),
      '--page-all', '--page-limit', String(MAX_MINUTES_LIST_PAGES),
    ], input.scope.profileId);
    const payload = await this.execute(args, input.scope, 'minutes.list');
    const page = parsePage(payload, ['minutes', 'itemList', 'items', 'tasks', 'list', 'records']);
    const from = Date.parse(input.window.from);
    const to = Date.parse(input.window.to);
    const parsed = page.items.map(parseMinutesRecord);
    const items = parsed
      .filter((item): item is DwsMinutesRecord => Boolean(item))
      .filter(item => {
        const timestamp = Date.parse(item.updatedAt ?? item.startedAt);
        return timestamp >= from && timestamp < to;
      });
    return pageResult(items, {
      ...page,
      truncated: page.truncated || parsed.some(item => item === null),
    });
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
      content: contentField(record, ['fullSummary', 'content', 'summary', 'markdown', 'text']),
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

    // DWS 把首个空转写页定义为分页末尾，即使响应仍携带 nextToken。
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
      const page = parsePage(payload, ['paragraphList', 'items', 'paragraphs', 'sentences', 'transcriptions', 'records']);
      const chunk = transcriptContent(payload, page.items);
      if (!chunk) break;
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
      await this.options.beforeExecute?.();
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
  const root = asRecord(payload);
  const directItems = [root.data, root.result].find(Array.isArray) as unknown[] | undefined;
  if (directItems) return { items: directItems, truncated: false };

  const records = objectCandidates(payload);
  const container = records.find(record => itemKeys.some(key => Array.isArray(record[key]))) ?? records[0] ?? {};
  const items = itemKeys.map(key => container[key]).find(Array.isArray) as unknown[] | undefined;
  const pagination = asRecord(asRecord(root.meta).pagination);
  const endpointExhausted = optionalBoolean(pagination, ['endpoint_exhausted', 'endpointExhausted']);
  const declaredHasMore = optionalBoolean(container, ['hasMore', 'has_more', 'hasNext', 'has_next', 'more']);
  const hasMore = declaredHasMore ?? (endpointExhausted === undefined ? undefined : !endpointExhausted);
  const nextCursor = optionalString(container, [
    'nextCursor', 'next_cursor', 'nextToken', 'next_token', 'nextPageToken', 'next_page_token', 'pageToken',
  ]) ?? optionalString(pagination, ['next_token', 'nextToken', 'next_cursor', 'nextCursor']);
  const complete = optionalBoolean(container, ['complete']);
  return {
    items: items ?? [],
    ...(hasMore === false ? {} : nextCursor ? { nextCursor } : {}),
    truncated: truncatedField(container)
      || (hasMore === true && !nextCursor)
      || (complete === false && !nextCursor),
  };
}

function pageResult<T>(items: T[], page: ParsedPage): DwsPage<T> {
  return {
    items,
    ...(!page.truncated && page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(page.truncated ? { truncated: true } : {}),
  };
}

function chatConversationId(value: unknown): string | undefined {
  return optionalString(asRecord(value), [
    'conversationId', 'conversation_id', 'openConversationId', 'open_conversation_id', 'cid',
  ]);
}

function parseChatMessage(value: unknown, inheritedConversationId?: string): DwsChatMessage | null {
  const record = asRecord(value);
  const messageId = optionalString(record, [
    'openMessageId', 'messageId', 'msgId', 'message_id', 'msg_id', 'id',
  ]);
  const conversationId = optionalString(record, [
    'conversationId', 'conversation_id', 'openConversationId', 'open_conversation_id', 'cid',
  ]) ?? inheritedConversationId;
  const createdAt = optionalTimestamp(record, ['createdAt', 'createTime', 'create_time', 'sendTime', 'timestamp']);
  if (!messageId || !conversationId || !createdAt) return null;
  const senderId = optionalString(record, [
    'senderId', 'sender_id', 'senderUserId', 'sender_user_id', 'senderOpenDingTalkId',
    'senderOpenDingtalkId', 'sender_open_dingtalk_id',
  ]) ?? optionalString(asRecord(record.sender), [
    'userId', 'user_id', 'openDingTalkId', 'openDingtalkId', 'open_dingtalk_id', 'id',
  ]);
  return {
    messageId,
    conversationId,
    text: contentField(record, ['text', 'content', 'message', 'body']),
    createdAt,
    ...(optionalTimestamp(record, ['updatedAt', 'updateTime', 'modifiedAt'])
      ? { updatedAt: optionalTimestamp(record, ['updatedAt', 'updateTime', 'modifiedAt']) } : {}),
    ...(senderId ? { senderId } : {}),
    ...(optionalString(record, ['url', 'messageUrl']) ? { url: optionalString(record, ['url', 'messageUrl']) } : {}),
    ...(truncatedField(record) ? { truncated: true } : {}),
  };
}

function isWikiFolder(value: unknown): boolean {
  const record = asRecord(value);
  const type = optionalString(record, ['nodeType', 'node_type', 'type', 'kind'])?.toLowerCase();
  return type === 'folder' || optionalBoolean(record, ['isFolder', 'is_folder']) === true;
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
    ...(optionalString(record, ['extension', 'fileExtension', 'file_extension', 'suffix'])
      ? { extension: optionalString(record, ['extension', 'fileExtension', 'file_extension', 'suffix']) } : {}),
    ...(optionalString(record, ['url', 'docUrl', 'doc_url', 'link'])
      ? { url: optionalString(record, ['url', 'docUrl', 'doc_url', 'link']) } : {}),
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
      const parts = [contentField(record, ['paragraph', 'text', 'content', 'sentence', 'transcription'])];
      if (Array.isArray(record.sentences)) {
        parts.push(...record.sentences.map(sentence => (
          contentField(asRecord(sentence), ['text', 'content', 'sentence', 'transcription'])
        )));
      }
      const text = [...new Set(parts.filter(Boolean))].join(' ');
      const speaker = optionalString(record, [
        'speakerName', 'speaker_name', 'speakerNick', 'speaker_nick', 'speaker',
      ]);
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
