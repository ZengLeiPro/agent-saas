import type {
  EventReplayLoadStats,
  EventStore,
  ModelRequestDiagnostic,
  PlatformEvent,
} from './types.js';
import { buildContextProjection, type ContextProjectionOptions } from './contextProjection.js';
import { closeUnfinishedReplayToolCalls } from './rawAgentLoopRecovery.js';
import { boundReplayToolResultEvents } from './replayEventBounds.js';

export const CHECKPOINT_REPLAY_PREFIX_EVENT_TYPES = [
  'user_message',
  'context_rewind',
  'mcp_tool_catalog_snapshot',
  'mcp_tools_loaded',
] as const satisfies readonly PlatformEvent['type'][];

const CHECKPOINT_REPLAY_PREFIX_TYPES = new Set<PlatformEvent['type']>(
  CHECKPOINT_REPLAY_PREFIX_EVENT_TYPES,
);
const REPLAY_PAGE_LIMIT = 1_000;

interface ReplayLoadResult {
  events: PlatformEvent[];
  cursor?: string;
  stats: EventReplayLoadStats;
}

export function selectCheckpointReplayWindow(events: PlatformEvent[]): {
  events: PlatformEvent[];
  checkpointEventId?: string;
  cutoffSequence?: number;
  prefixEventCount: number;
  tailEventCount: number;
} {
  let checkpointIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== 'compaction') continue;
    if (event.checkpoint?.version !== 1) return fullWindow(events);
    checkpointIndex = index;
    break;
  }
  if (checkpointIndex < 0) return fullWindow(events);

  const checkpoint = events[checkpointIndex]!;
  if (checkpoint.type !== 'compaction') return fullWindow(events);
  let cutoffIndex = checkpointIndex;
  if (checkpoint.cutoffEventId) {
    cutoffIndex = events.findIndex(
      (event, index) => index <= checkpointIndex && event.id === checkpoint.cutoffEventId,
    );
    if (cutoffIndex < 0) return fullWindow(events);
  }

  let prefixEventCount = 0;
  const selected = events.filter((event, index) => {
    if (index >= cutoffIndex) return true;
    const include = CHECKPOINT_REPLAY_PREFIX_TYPES.has(event.type);
    if (include) prefixEventCount += 1;
    return include;
  });
  return {
    events: selected,
    checkpointEventId: checkpoint.id,
    cutoffSequence: eventSequence(events[cutoffIndex], cutoffIndex + 1),
    prefixEventCount,
    tailEventCount: events.length - cutoffIndex,
  };
}

function fullWindow(events: PlatformEvent[]) {
  return {
    events,
    prefixEventCount: 0,
    tailEventCount: events.length,
  };
}

function eventSequence(event: PlatformEvent | undefined, fallback: number): number {
  const sequence = (event as (PlatformEvent & { sequence?: unknown }) | undefined)?.sequence;
  return typeof sequence === 'number' && Number.isFinite(sequence) ? sequence : fallback;
}

function lastCursor(events: PlatformEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const sequence = (events[index] as PlatformEvent & { sequence?: unknown })?.sequence;
    if (typeof sequence === 'number' && Number.isFinite(sequence)) return String(sequence);
  }
  return undefined;
}

function serializedUtf8Bytes(values: readonly unknown[]): number {
  return values.reduce<number>(
    (total, value) => total + Buffer.byteLength(JSON.stringify(value), 'utf8'),
    0,
  );
}

export function buildMeasuredContextProjection(
  events: PlatformEvent[],
  options: ContextProjectionOptions,
  diagnostics: { sessionId: string; runId: string; logger: { info(message: string): void } },
) {
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const projection = buildContextProjection(events, options);
  const heapAfter = process.memoryUsage().heapUsed;
  diagnostics.logger.info(
    `[RuntimeReplayProjection] ${JSON.stringify({
      sessionId: diagnostics.sessionId,
      runId: diagnostics.runId,
      eventsLoaded: events.length,
      eventsSelected: projection.selectedEvents.length,
      messageCount: projection.messages.length,
      projectionBytes: serializedUtf8Bytes(projection.messages),
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      heapBeforeBytes: heapBefore,
      heapAfterBytes: heapAfter,
      heapDeltaBytes: heapAfter - heapBefore,
    })}`,
  );
  return projection;
}

export function logRuntimeModelRequest(
  diagnostics: { sessionId: string; runId: string; logger: { info(message: string): void } },
  value: ModelRequestDiagnostic,
): void {
  if (value.type !== 'started') return;
  const memory = process.memoryUsage();
  diagnostics.logger.info(
    `[RuntimeModelRequest] ${JSON.stringify({
      sessionId: diagnostics.sessionId,
      runId: diagnostics.runId,
      modelRequestId: value.modelRequestId,
      attemptId: value.attemptId,
      attempt: value.attempt,
      requestBodyBytes: value.requestBodyBytes,
      toolsCount: value.toolsCount,
      hasPreviousResponseId: value.hasPreviousResponseId,
      heapUsedBytes: memory.heapUsed,
      rssBytes: memory.rss,
      externalBytes: memory.external,
    })}`,
  );
}

export async function loadRuntimeReplaySnapshot(input: {
  eventStore: EventStore;
  tenantId: string;
  sessionId: string;
  runId: string;
  reason: string;
  excludeTypes: PlatformEvent['type'][];
  logger?: { info(message: string): void };
}): Promise<ReplayLoadResult> {
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const loaded = await loadRuntimeReplayEvents(
    input.eventStore,
    input.tenantId,
    input.sessionId,
    input.excludeTypes,
  );
  logReplayLoad(input, loaded.stats, heapBefore, startedAt);
  return loaded;
}

export async function loadRuntimeReplayEvents(
  eventStore: EventStore,
  tenantId: string,
  sessionId: string,
  excludeTypes: PlatformEvent['type'][] = [],
): Promise<ReplayLoadResult> {
  let stats: EventReplayLoadStats | undefined;
  const events = await eventStore.list(tenantId, sessionId, {
    excludeTypes,
    replayMode: 'checkpoint',
    replayStats: (value) => {
      stats = value;
    },
  });
  if (stats) return { events, ...(stats.cursor ? { cursor: stats.cursor } : {}), stats };
  return fallbackResult(boundReplayToolResultEvents(events));
}

function fallbackResult(full: PlatformEvent[]): ReplayLoadResult {
  const selected = selectCheckpointReplayWindow(full);
  return {
    events: selected.events,
    ...(lastCursor(full) ? { cursor: lastCursor(full) } : {}),
    stats: {
      strategy: selected.checkpointEventId ? 'checkpoint' : 'full',
      totalEventCount: full.length,
      selectedEventCount: selected.events.length,
      selectedProjectedBytes: serializedUtf8Bytes(selected.events),
      prefixEventCount: selected.prefixEventCount,
      tailEventCount: selected.tailEventCount,
      ...(selected.checkpointEventId ? { checkpointEventId: selected.checkpointEventId } : {}),
      ...(selected.cutoffSequence ? { cutoffSequence: selected.cutoffSequence } : {}),
    },
  };
}

function logReplayLoad(
  input: Pick<
    Parameters<typeof loadRuntimeReplaySnapshot>[0],
    'logger' | 'sessionId' | 'runId' | 'reason'
  >,
  stats: EventReplayLoadStats,
  heapBefore: number,
  startedAt: number,
): void {
  if (!input.logger) return;
  const heapAfter = process.memoryUsage().heapUsed;
  input.logger.info(
    `[RuntimeReplayLoad] ${JSON.stringify({
      sessionId: input.sessionId,
      runId: input.runId,
      reason: input.reason,
      ...stats,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      heapBeforeBytes: heapBefore,
      heapAfterBytes: heapAfter,
      heapDeltaBytes: heapAfter - heapBefore,
    })}`,
  );
}

export class IncrementalRuntimeReplayLoader {
  private events?: PlatformEvent[];
  private cursor?: string;

  constructor(
    private readonly input: Omit<Parameters<typeof loadRuntimeReplaySnapshot>[0], 'reason'>,
  ) {}

  async load(reason: string): Promise<PlatformEvent[]> {
    if (!this.events || !this.cursor || !this.input.eventStore.listPage) {
      return this.reload(reason);
    }
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = performance.now();
    const appended: PlatformEvent[] = [];
    let cursor = this.cursor;
    let hasMore = false;
    do {
      const page = await this.input.eventStore.listPage(this.input.tenantId, this.input.sessionId, {
        afterCursor: cursor,
        limit: REPLAY_PAGE_LIMIT,
        excludeTypes: this.input.excludeTypes,
        replayMode: 'bounded',
      });
      appended.push(...page.events);
      cursor = page.nextCursor ?? lastCursor(page.events) ?? cursor;
      hasMore = page.hasMore;
      if (hasMore && !page.nextCursor) return this.reload(`${reason}:cursor_fallback`);
    } while (hasMore);

    if (appended.some((event) => event.type === 'compaction'))
      return this.reload(`${reason}:checkpoint_refresh`);
    const knownEventIds = new Set(this.events.map((event) => event.id));
    this.events.push(...appended.filter((event) => !knownEventIds.has(event.id)));
    this.cursor = cursor;
    logReplayLoad(
      this.inputWithReason(reason),
      {
        strategy: 'incremental',
        totalEventCount: appended.length,
        selectedEventCount: appended.length,
        selectedProjectedBytes: serializedUtf8Bytes(appended),
        prefixEventCount: 0,
        tailEventCount: appended.length,
      },
      heapBefore,
      startedAt,
    );
    return this.events;
  }

  private async reload(reason: string): Promise<PlatformEvent[]> {
    const loaded = await loadRuntimeReplaySnapshot(this.inputWithReason(reason));
    this.events = loaded.events;
    this.cursor = loaded.cursor ?? lastCursor(loaded.events);
    return this.events;
  }

  private inputWithReason(reason: string): Parameters<typeof loadRuntimeReplaySnapshot>[0] {
    return { ...this.input, reason };
  }
}

export async function createRuntimeReplayAccess(input: {
  eventStore: EventStore;
  tenantId: string;
  sessionId: string;
  runId: string;
  sourceSessionId?: string;
  excludeTypes: PlatformEvent['type'][];
  logger?: { info(message: string): void };
}) {
  const loaderInput = {
    eventStore: input.eventStore,
    tenantId: input.tenantId,
    runId: input.runId,
    excludeTypes: input.excludeTypes,
    ...(input.logger ? { logger: input.logger } : {}),
  };
  const current = new IncrementalRuntimeReplayLoader({
    ...loaderInput,
    sessionId: input.sessionId,
  });
  const sourceEvents = input.sourceSessionId
    ? closeUnfinishedReplayToolCalls(
        (
          await loadRuntimeReplaySnapshot({
            ...loaderInput,
            sessionId: input.sourceSessionId,
            reason: 'source_snapshot',
          })
        ).events,
        input.sourceSessionId,
      )
    : [];
  const combine = (events: PlatformEvent[]) =>
    input.sourceSessionId ? [...sourceEvents, ...events] : events;
  return {
    sourceEvents,
    loadCurrent: (reason: string) => current.load(reason),
    loadEffective: async (reason: string) => combine(await current.load(reason)),
    combine,
  };
}
