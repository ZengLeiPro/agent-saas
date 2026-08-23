import {
  createIngestPage,
  normalizeChatMessage,
  normalizeMinutes,
  normalizeWikiDocument,
} from './normalizers.js';
import type { ContextSyncStore, DwsContextClient, DwsPage } from './ports.js';
import type {
  ContextIngestItem,
  ContextSyncKey,
  ContextSyncResult,
  ContextSyncScope,
  ContextSyncSource,
  ContextSyncWindow,
  DwsContextWakeEvent,
  DwsContextWakeResult,
} from './types.js';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_CONTENT_CHARACTERS = 100_000;
const DEFAULT_MAX_PAGES = 10_000;
const MESSAGE_EVENT_TYPES = new Set([
  'user_im_message_receive_at',
  'user_im_message_receive_o2o_all',
]);

export interface DwsContextSyncServiceOptions {
  store: ContextSyncStore;
  client: DwsContextClient;
  clock?: () => Date;
  defaultLookbackMs?: number;
  defaultPageSize?: number;
  maxContentCharacters?: number;
  maxPages?: number;
}

export interface ContextSyncRequest {
  scope: ContextSyncScope;
  source: ContextSyncSource;
  conversationId?: string;
  conversationIds?: readonly string[];
  from?: string;
  /** Lower bound used only for a target that does not yet have a watermark. */
  initialFrom?: string;
  to?: string;
  pageSize?: number;
}

/** Database-independent coordinator; persistence and DWS execution live behind ports. */
export class DwsContextSyncService {
  private readonly clock: () => Date;
  private readonly defaultLookbackMs: number;
  private readonly defaultPageSize: number;
  private readonly maxContentCharacters: number;
  private readonly maxPages: number;

  constructor(private readonly options: DwsContextSyncServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.defaultLookbackMs = positiveInteger(options.defaultLookbackMs, DEFAULT_LOOKBACK_MS);
    this.defaultPageSize = positiveInteger(options.defaultPageSize, DEFAULT_PAGE_SIZE);
    this.maxContentCharacters = positiveInteger(
      options.maxContentCharacters,
      DEFAULT_MAX_CONTENT_CHARACTERS,
    );
    this.maxPages = positiveInteger(options.maxPages, DEFAULT_MAX_PAGES);
  }

  async syncWindow(request: ContextSyncRequest): Promise<ContextSyncResult> {
    validateRequest(request);
    const key: ContextSyncKey = {
      ...request.scope,
      source: request.source,
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      ...(request.conversationIds ? { conversationIds: [...request.conversationIds] } : {}),
    };
    const expectedWatermark = await this.options.store.getWatermark(key);
    const to = canonicalTimestamp(request.to ?? this.clock().toISOString(), 'window.to');
    const from = canonicalTimestamp(
      request.from
        ?? expectedWatermark
        ?? request.initialFrom
        ?? new Date(Date.parse(to) - this.defaultLookbackMs).toISOString(),
      'window.from',
    );
    if (Date.parse(from) > Date.parse(to)) throw new Error('Context sync window.from must not exceed window.to');
    if (expectedWatermark && Date.parse(to) < Date.parse(expectedWatermark)) {
      throw new Error('Context sync watermark cannot move backwards');
    }
    const window = { from, to };
    const pageSize = positiveInteger(request.pageSize, this.defaultPageSize);

    try {
      const resumeCursor = await this.options.store.getResumeCursor(key, window);
      const result = await this.pullAllPages(key, window, pageSize, resumeCursor);
      await this.options.store.advanceWatermark({ key, expected: expectedWatermark, value: window.to });
      await this.options.store.clearRetryState(key);
      return { ...result, watermarkAdvanced: true };
    } catch (error) {
      try {
        await this.options.store.recordRetryFailure({
          key,
          window,
          error: compactError(error),
          failedAt: this.clock().toISOString(),
        });
      } catch {
        // A policy reset intentionally invalidates the old fence. Never reacquire
        // from the stale operation merely to persist its retry state.
      }
      throw error;
    }
  }

  async getRetryState(key: ContextSyncKey) {
    return this.options.store.getRetryState(key);
  }

  /** Replays exactly the durable failed window; no retry schedule lives in memory. */
  async retry(key: ContextSyncKey): Promise<ContextSyncResult | null> {
    const retry = await this.options.store.getRetryState(key);
    if (!retry) return null;
    return this.syncWindow({
      scope: scopeFromKey(key),
      source: key.source,
      ...(key.conversationId ? { conversationId: key.conversationId } : {}),
      ...(key.conversationIds ? { conversationIds: key.conversationIds } : {}),
      from: retry.window.from,
      to: retry.window.to,
    });
  }

  /**
   * Stream notifications are wakes only. Their content/message body is ignored;
   * canonical messages are fetched for the one addressed conversation.
   */
  async handleEvent(scope: ContextSyncScope, event: DwsContextWakeEvent): Promise<DwsContextWakeResult> {
    if (!MESSAGE_EVENT_TYPES.has(event.type)) return { woken: false, reason: 'unsupported_event' };
    const conversationId = optionalText(event.conversationId);
    if (!conversationId) return { woken: false, reason: 'missing_conversation' };
    const sync = await this.syncWindow({
      scope,
      source: 'chat',
      conversationId,
      to: this.clock().toISOString(),
    });
    return { woken: true, sync };
  }

  private async pullAllPages(
    key: ContextSyncKey,
    window: ContextSyncWindow,
    pageSize: number,
    resumeCursor?: string,
  ): Promise<Omit<ContextSyncResult, 'watermarkAdvanced'>> {
    let cursor = optionalText(resumeCursor);
    let pages = 0;
    let items = 0;
    let truncated = false;
    const seenCursors = new Set<string>(cursor ? [cursor] : []);
    const inventoryExternalRecordIds = new Set<string>();

    while (true) {
      if (pages >= this.maxPages) throw new Error(`Context sync exceeded ${this.maxPages} pages`);
      const upstream = await this.fetchPage(key, window, cursor, pageSize);
      const normalizedItems = await this.normalizePage(key, window, upstream.items);
      for (const item of normalizedItems) inventoryExternalRecordIds.add(item.idempotencyKey);
      const upstreamPageTruncated = Boolean(upstream.truncated);
      const upstreamItemTruncated = normalizedItems.some(
        item => item.truncation.truncated && item.truncation.reason === 'upstream',
      );
      const upstreamTruncated = upstreamPageTruncated || upstreamItemTruncated;
      const ingestPage = createIngestPage({
        context: { key, window, maxContentCharacters: this.maxContentCharacters },
        ...(cursor ? { cursor } : {}),
        ...(!upstreamTruncated && upstream.nextCursor ? { nextCursor: upstream.nextCursor } : {}),
        upstreamTruncated,
        items: normalizedItems,
      });
      await this.options.store.ingestPage(ingestPage);
      pages += 1;
      items += normalizedItems.length;
      truncated ||= ingestPage.truncated;
      if (upstreamTruncated) {
        throw new Error(`DWS ${key.source} returned truncated upstream content`);
      }

      const nextCursor = optionalText(upstream.nextCursor);
      if (!nextCursor) break;
      if (nextCursor === cursor || seenCursors.has(nextCursor)) {
        throw new Error(`DWS ${key.source} pagination cursor did not advance`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    if (key.source === 'wiki') {
      await this.options.store.reconcileInventory({
        key,
        window,
        externalRecordIds: [...inventoryExternalRecordIds],
      });
    }
    return { key, window, pages, items, truncated };
  }

  private fetchPage(
    key: ContextSyncKey,
    window: ContextSyncWindow,
    cursor: string | undefined,
    pageSize: number,
  ): Promise<DwsPage<unknown>> {
    const common = {
      scope: scopeFromKey(key),
      window,
      ...(cursor ? { cursor } : {}),
      pageSize,
    };
    if (key.source === 'chat') {
      return this.options.client.listChatMessages({
        ...common,
        ...(key.conversationId ? { conversationId: key.conversationId } : {}),
        ...(key.conversationIds ? { conversationIds: key.conversationIds } : {}),
      });
    }
    if (key.source === 'wiki') return this.options.client.listWikiDocuments(common);
    return this.options.client.listMinutes(common);
  }

  private async normalizePage(
    key: ContextSyncKey,
    window: ContextSyncWindow,
    rawItems: unknown[],
  ): Promise<ContextIngestItem[]> {
    const context = { key, window, maxContentCharacters: this.maxContentCharacters };
    if (key.source === 'chat') {
      return rawItems.map(item => normalizeChatMessage(context, item as Parameters<typeof normalizeChatMessage>[1]));
    }
    if (key.source === 'wiki') {
      const items: ContextIngestItem[] = [];
      for (const raw of rawItems) {
        const document = raw as Parameters<typeof normalizeWikiDocument>[1];
        try {
          const body = await this.options.client.getWikiDocumentBody({
            scope: scopeFromKey(key),
            documentId: document.documentId,
            ...(document.extension ? { extension: document.extension } : {}),
          });
          items.push(normalizeWikiDocument(context, document, body));
        } catch (error) {
          if (!isWikiDocumentRevokedError(error)) throw error;
          items.push({
            ...normalizeWikiDocument(context, document, {
              content: '',
              format: 'metadata-only',
              unreadable: true,
              unreadableReason: 'document_revoked',
            }),
            revoked: true,
          });
        }
      }
      return items;
    }
    const items: ContextIngestItem[] = [];
    for (const raw of rawItems) {
      const minutes = raw as Parameters<typeof normalizeMinutes>[1];
      const summary = await this.options.client.getMinutesSummary({
        scope: scopeFromKey(key),
        minutesId: minutes.minutesId,
      });
      const transcript = await this.options.client.getMinutesTranscript({
        scope: scopeFromKey(key),
        minutesId: minutes.minutesId,
      });
      items.push(normalizeMinutes(context, minutes, summary, transcript));
    }
    return items;
  }
}

function isWikiDocumentRevokedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b403\b|\b404\b|forbidden|permission denied|access denied|not found)/i.test(message);
}

function scopeFromKey(key: ContextSyncKey): ContextSyncScope {
  return { tenantId: key.tenantId, accountId: key.accountId, profileId: key.profileId };
}

function validateRequest(request: ContextSyncRequest): void {
  requiredText(request.scope.tenantId, 'tenantId');
  requiredText(request.scope.accountId, 'accountId');
  requiredText(request.scope.profileId, 'profileId');
  if ((request.conversationId || request.conversationIds) && request.source !== 'chat') {
    throw new Error('Context sync conversation target is only valid for chat');
  }
  if (request.conversationId && request.conversationIds) {
    throw new Error('Context sync conversation target must use one scope form');
  }
  if (request.conversationIds) {
    if (request.conversationIds.length === 0
      || request.conversationIds.some(value => !optionalText(value))
      || new Set(request.conversationIds).size !== request.conversationIds.length) {
      throw new Error('Context sync selected conversations must be non-empty and unique');
    }
  }
}

function requiredText(value: unknown, label: string): string {
  const text = optionalText(value);
  if (!text) throw new Error(`Context sync ${label} is required`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function canonicalTimestamp(value: string, label: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`Context sync ${label} is invalid`);
  return new Date(millis).toISOString();
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|authorization|token)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || 'unknown_error';
}
