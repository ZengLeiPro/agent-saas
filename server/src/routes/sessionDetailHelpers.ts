import type { Request } from 'express';
import {
  findMetaPathBySessionId,
  findTranscriptPathBySessionId,
  getTranscriptPath,
  statTrustedTranscript,
  type ParsedTranscript,
} from '../data/transcripts/index.js';
import type { SessionShareSnapshot } from '../data/sessionShares/store.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import type { EventStore, PlatformEvent } from '../runtime/types.js';
import type { RunLiveness } from '../runtime/runLiveness.js';

const SESSION_DETAIL_DELTA_OVERLAP_BLOCKS = 32;
export const SESSION_DETAIL_DEFAULT_PAGE_SIZE = 100;
export const SESSION_DETAIL_MAX_PAGE_SIZE = 200;

export type SessionDetailPayload = SessionShareSnapshot & {
  mode: 'full' | 'delta' | 'before';
  cursor?: string;
  oldestCursor?: string;
  historyComplete?: boolean;
  /** Canonical M40-02 backward-history cursor (alias of oldestCursor during migration). */
  nextCursor?: string;
  hasMore?: boolean;
  historyRevision?: string;
  after?: string;
  before?: string;
};

export interface SessionDetailPayloadOptions {
  after?: string;
  before?: string;
  /** N-1 numeric compatibility path; never combined with canonical cursors. */
  offset?: number;
  limit?: number;
  /** window API 未从文件起点解析时，用于避免误报 historyComplete。 */
  windowStartsAtBeginning?: boolean;
  /** before 窗口不含 EOF，由窗口 API 提供真实最新 cursor。 */
  latestCursor?: string;
  /** Transcript generation fence; changes on truncate/replace/compaction. */
  historyRevision?: string;
}

function semanticOrderForBlockId(blockId: string): { sequence: number; eventIndex: number; stableId: string } | undefined {
  const match = /^line-(\d+)(?:-.*?-(\d+))?(?:-|$)/.exec(blockId);
  if (!match) return undefined;
  const sequence = Number(match[1]);
  const eventIndex = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(eventIndex)) return undefined;
  return { sequence, eventIndex, stableId: blockId };
}

function withoutTranscriptRaw(blocks: SessionShareSnapshot['blocks']): SessionShareSnapshot['blocks'] {
  return blocks.map(({ raw: _raw, ...block }) => {
    const semanticOrder = semanticOrderForBlockId(block.id);
    return { ...block, ...(semanticOrder ? { semanticOrder } : {}) };
  });
}

/** Project the transcript detail window without exposing raw transcript records. */
export function buildSessionDetailPayload(
  detail: SessionShareSnapshot,
  options: SessionDetailPayloadOptions = {},
): SessionDetailPayload {
  const { after, before } = options;
  const requestedLimit = options.limit === undefined
    ? undefined
    : Math.min(
      SESSION_DETAIL_MAX_PAGE_SIZE,
      Math.max(1, Math.floor(options.limit || SESSION_DETAIL_DEFAULT_PAGE_SIZE)),
    );
  const cursor = options.latestCursor ?? detail.blocks.at(-1)?.id;
  const windowStartsAtBeginning = options.windowStartsAtBeginning ?? true;

  if (after) {
    const afterIndex = detail.blocks.findIndex((block) => block.id === after);
    const addedBlockCount = afterIndex >= 0 ? detail.blocks.length - afterIndex - 1 : 0;
    if (afterIndex >= 0 && (requestedLimit === undefined || addedBlockCount <= requestedLimit)) {
      const start = Math.max(0, afterIndex - SESSION_DETAIL_DELTA_OVERLAP_BLOCKS + 1);
      return {
        ...detail,
        mode: 'delta',
        blocks: withoutTranscriptRaw(detail.blocks.slice(start)),
        after,
        ...(cursor ? { cursor } : {}),
        ...(options.historyRevision ? { historyRevision: options.historyRevision } : {}),
      };
    }
  }

  if (before) {
    const beforeIndex = detail.blocks.findIndex((block) => block.id === before);
    if (beforeIndex >= 0) {
      const limit = requestedLimit ?? SESSION_DETAIL_DEFAULT_PAGE_SIZE;
      const start = Math.max(0, beforeIndex - limit);
      const blocks = detail.blocks.slice(start, beforeIndex + 1);
      const historyComplete = start === 0 && windowStartsAtBeginning;
      return {
        ...detail,
        mode: 'before',
        blocks: withoutTranscriptRaw(blocks),
        before,
        historyComplete,
        hasMore: !historyComplete,
        ...(blocks[0]?.id ? { oldestCursor: blocks[0].id, nextCursor: blocks[0].id } : {}),
        ...(cursor ? { cursor } : {}),
        ...(options.historyRevision ? { historyRevision: options.historyRevision } : {}),
      };
    }
  }

  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const end = offset > 0 ? Math.max(0, detail.blocks.length - offset) : detail.blocks.length;
  const start = requestedLimit === undefined ? 0 : Math.max(0, end - requestedLimit);
  const blocks = detail.blocks.slice(start, end);
  const historyComplete = start === 0 && windowStartsAtBeginning;
  return {
    ...detail,
    mode: 'full',
    blocks: withoutTranscriptRaw(blocks),
    historyComplete,
    hasMore: !historyComplete,
    ...(blocks[0]?.id ? { oldestCursor: blocks[0].id, nextCursor: blocks[0].id } : {}),
    ...(cursor ? { cursor } : {}),
    ...(options.historyRevision ? { historyRevision: options.historyRevision } : {}),
  };
}

export interface ResolvedSessionPath {
  transcriptPath: string;
  hasTranscript: boolean;
}

export async function resolveSessionPathForRead(
  userCwd: string,
  sessionId: string,
  owner?: { tenantId?: string; userId?: string },
): Promise<ResolvedSessionPath | null> {
  const transcriptPath = getTranscriptPath(userCwd, sessionId, owner);
  try {
    await statTrustedTranscript(transcriptPath);
    return { transcriptPath, hasTranscript: true };
  } catch {
    const foundTranscript = await findTranscriptPathBySessionId(sessionId);
    if (foundTranscript) return { transcriptPath: foundTranscript, hasTranscript: true };
    const foundMeta = await findMetaPathBySessionId(sessionId);
    return foundMeta ? { transcriptPath: foundMeta, hasTranscript: false } : null;
  }
}

export interface LastRunState {
  runId: string;
  status: string;
  error?: string;
  failureKind?: 'policy_rejection';
  recoveryAction?: 'switch_model';
  finishedAt?: string;
  liveness?: RunLiveness;
}

export async function getLastRunState(
  eventStore: EventStore,
  tenantId: string,
  sessionId: string,
): Promise<LastRunState | undefined> {
  try {
    const collected: PlatformEvent[] = [];
    if (eventStore.listPage) {
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await eventStore.listPage(tenantId, sessionId, {
          type: 'run_state_changed',
          limit: 200,
          afterCursor: cursor,
        });
        collected.push(...page.events);
        if (!page.hasMore || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
    } else {
      for (const event of await eventStore.list(tenantId, sessionId)) {
        if (event.type === 'run_state_changed') collected.push(event);
      }
    }
    const last = collected.at(-1);
    if (!last || last.type !== 'run_state_changed') return undefined;
    return {
      runId: last.runId,
      status: last.status,
      ...(last.reason ? { error: last.reason } : {}),
      ...(last.failureKind ? { failureKind: last.failureKind } : {}),
      ...(last.recoveryAction ? { recoveryAction: last.recoveryAction } : {}),
      ...(last.timestamp ? { finishedAt: last.timestamp } : {}),
    };
  } catch {
    return undefined;
  }
}

function isUserMessageSubmittedEvent(
  event: PlatformEvent,
): event is Extract<PlatformEvent, { type: 'user_message_submitted' }> {
  return event.type === 'user_message_submitted'
    && typeof event.content === 'string'
    && event.content.trim().length > 0;
}

export async function buildMetaOnlyTranscript(
  tenantId: string,
  sessionId: string,
  transcriptPath: string,
  runtimeEventStoreFor?: (transcriptPath: string, tenantId: string) => EventStore,
): Promise<ParsedTranscript> {
  let events: PlatformEvent[] = [];
  try {
    const eventStore = runtimeEventStoreFor
      ? runtimeEventStoreFor(transcriptPath, tenantId)
      : new FileEventStore(getRuntimeEventLogPath(transcriptPath), tenantId);
    events = await eventStore.list(tenantId, sessionId);
  } catch {
    events = [];
  }
  const submitted = events.filter(isUserMessageSubmittedEvent);
  return {
    sessionId,
    blocks: submitted.map((event, index) => {
      const parsedTs = Date.parse(event.timestamp);
      return {
        id: `runtime-${event.id || index}-user`,
        ...(Number.isFinite(parsedTs) ? { tsMs: parsedTs } : {}),
        kind: 'prompt' as const,
        title: '输入（Prompt）',
        defaultOpen: true,
        content: event.content,
      };
    }),
    stats: { lines: submitted.length, parsedLines: submitted.length, parseErrors: 0 },
  };
}

export function reqTranscriptOwner(
  reqUser: Request['user'] | undefined,
): { tenantId?: string; userId?: string } | undefined {
  return reqUser ? { tenantId: reqUser.tenantId, userId: reqUser.sub } : undefined;
}

export function filterProjectedQueuedMessages<T extends { sourceRunId: string }>(
  pending: T[],
  blocks: Array<{ interjectionSourceRunId?: string }>,
  durableProjectedSourceRunIds: Iterable<string> = [],
): T[] {
  const projectedSourceRunIds = new Set(durableProjectedSourceRunIds);
  for (const block of blocks) {
    if (block.interjectionSourceRunId) projectedSourceRunIds.add(block.interjectionSourceRunId);
  }
  return pending.filter((input) => !projectedSourceRunIds.has(input.sourceRunId));
}
