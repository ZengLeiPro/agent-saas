import type {
  DwsChatMessage,
  DwsMinutesContent,
  DwsMinutesRecord,
  DwsWikiDocument,
  DwsWikiDocumentBody,
} from './ports.js';
import type {
  ContextContentTruncation,
  ContextIngestItem,
  ContextIngestPage,
  ContextSyncKey,
  ContextSyncWindow,
} from './types.js';

export const CONTEXT_TRUNCATION_MARKER = '\n\n[上下文已截断]';

interface NormalizationContext {
  key: ContextSyncKey;
  window: ContextSyncWindow;
  maxContentCharacters: number;
}

export function normalizeChatMessage(
  context: NormalizationContext,
  message: DwsChatMessage,
): ContextIngestItem {
  const content = boundContent(message.text, context.maxContentCharacters, Boolean(message.truncated));
  return {
    idempotencyKey: stableItemKey(context.key, message.messageId),
    source: 'chat',
    sourceId: message.messageId,
    kind: 'chat_message',
    content: content.value,
    conversationId: message.conversationId,
    occurredAt: message.createdAt,
    ...(message.updatedAt ? { updatedAt: message.updatedAt } : {}),
    ...(message.url ? { url: message.url } : {}),
    metadata: {
      ...(message.senderId ? { senderId: message.senderId } : {}),
    },
    truncation: content.truncation,
  };
}

export function normalizeWikiDocument(
  context: NormalizationContext,
  document: DwsWikiDocument,
  body: DwsWikiDocumentBody,
): ContextIngestItem {
  const content = boundContent(body.content, context.maxContentCharacters, Boolean(body.truncated));
  return {
    idempotencyKey: stableItemKey(context.key, document.documentId),
    source: 'wiki',
    sourceId: document.documentId,
    kind: 'wiki_document',
    title: document.title,
    content: content.value,
    occurredAt: document.createdAt ?? document.updatedAt,
    updatedAt: body.updatedAt ?? document.updatedAt,
    ...(document.url ? { url: document.url } : {}),
    metadata: {
      ...(document.spaceId ? { spaceId: document.spaceId } : {}),
      ...(body.format ? { format: body.format } : {}),
    },
    truncation: content.truncation,
  };
}

export function normalizeMinutes(
  context: NormalizationContext,
  minutes: DwsMinutesRecord,
  summary: DwsMinutesContent,
  transcript: DwsMinutesContent,
): ContextIngestItem {
  const joined = [
    summary.content ? `摘要\n${summary.content}` : '',
    transcript.content ? `转写\n${transcript.content}` : '',
  ].filter(Boolean).join('\n\n');
  const content = boundContent(
    joined,
    context.maxContentCharacters,
    Boolean(summary.truncated || transcript.truncated),
  );
  return {
    idempotencyKey: stableItemKey(context.key, minutes.minutesId),
    source: 'minutes',
    sourceId: minutes.minutesId,
    kind: 'minutes',
    title: minutes.title,
    content: content.value,
    occurredAt: minutes.startedAt,
    ...(minutes.updatedAt ? { updatedAt: minutes.updatedAt } : {}),
    ...(minutes.url ? { url: minutes.url } : {}),
    metadata: {
      hasSummary: Boolean(summary.content),
      hasTranscript: Boolean(transcript.content),
      ...(minutes.durationSeconds !== undefined ? { durationSeconds: minutes.durationSeconds } : {}),
    },
    truncation: content.truncation,
  };
}

export function createIngestPage(input: {
  context: NormalizationContext;
  cursor?: string;
  nextCursor?: string;
  upstreamTruncated?: boolean;
  items: ContextIngestItem[];
}): ContextIngestPage {
  return {
    key: input.context.key,
    window: input.context.window,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
    items: input.items,
    truncated: Boolean(input.upstreamTruncated || input.items.some(item => item.truncation.truncated)),
  };
}

function stableItemKey(key: ContextSyncKey, sourceId: string): string {
  return ['dws', key.tenantId, key.accountId, key.profileId, key.source, sourceId]
    .map(encodeURIComponent)
    .join(':');
}

function boundContent(
  value: string,
  maxCharacters: number,
  upstreamTruncated: boolean,
): { value: string; truncation: ContextContentTruncation } {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) {
    return {
      value,
      truncation: upstreamTruncated
        ? { truncated: true, reason: 'upstream' }
        : { truncated: false },
    };
  }
  const marker = Array.from(CONTEXT_TRUNCATION_MARKER);
  const keep = Math.max(0, maxCharacters - marker.length);
  return {
    value: characters.slice(0, keep).concat(marker.slice(0, maxCharacters - keep)).join(''),
    truncation: {
      truncated: true,
      reason: upstreamTruncated ? 'upstream' : 'content_limit',
      limitCharacters: maxCharacters,
      originalCharacters: characters.length,
    },
  };
}
