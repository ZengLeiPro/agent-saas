import { randomUUID } from 'crypto';
import { dirname, resolve } from 'node:path';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import {
  appendTrustedFile,
  readTrustedFile,
  relativeToTrustedRoot,
} from '../security/trustedFile.js';
import { boundReplayToolResultEvents } from './replayEventBounds.js';
import type { EventAppendContext, EventListOptions, EventStore, PlatformEvent, PlatformEventInput } from './types.js';

function projectUsageEvent(event: PlatformEvent): PlatformEvent {
  const projected = { ...event } as PlatformEvent & { content?: unknown; modelContent?: unknown };
  delete projected.content;
  delete projected.modelContent;
  return projected;
}

export function getRuntimeEventLogPath(transcriptPath: string): string {
  return transcriptPath.endsWith('.jsonl')
    ? transcriptPath.slice(0, -'.jsonl'.length) + '.runtime-events.jsonl'
    : `${transcriptPath}.runtime-events.jsonl`;
}

const eventReadsInFlight = new Map<string, Promise<string | null>>();

function defaultTrustedRoot(filePath: string): string {
  try {
    relativeToTrustedRoot(AGENT_LEGACY_TRANSCRIPTS_ROOT, filePath);
    return AGENT_LEGACY_TRANSCRIPTS_ROOT;
  } catch (error) {
    if (!process.argv.some((argument) => argument.includes('vitest'))) throw error;
    return dirname(filePath);
  }
}

export class FileEventStore implements EventStore {
  private readonly trustedRoot: string;
  private readonly relativePath: string;
  private readonly cacheKey: string;
  private readonly tenantId: string;

  constructor(
    filePath: string,
    tenantId: string,
    trustedRoot = defaultTrustedRoot(filePath),
  ) {
    this.tenantId = requireTenantId(tenantId);
    this.trustedRoot = trustedRoot;
    this.relativePath = relativeToTrustedRoot(trustedRoot, filePath);
    this.cacheKey = resolve(trustedRoot, this.relativePath);
  }

  async append(event: PlatformEventInput, ctx: EventAppendContext): Promise<PlatformEvent> {
    return (await this.appendBatch([event], ctx))[0]!;
  }

  async appendBatch(events: PlatformEventInput[], ctx: EventAppendContext): Promise<PlatformEvent[]> {
    // JSONL 路径由 session record 物理隔离；同时把 store 绑定 tenant，并在每次
    // 操作显式校验 scope，避免错误 tenant 复用同一路径时读写成功。
    this.assertTenant(ctx.tenantId);
    if (events.length === 0) return [];
    const timestamp = new Date().toISOString();
    const fullEvents = events.map((event) => ({
      id: randomUUID(),
      timestamp,
      ...event,
    } as PlatformEvent));
    await appendTrustedFile(
      this.trustedRoot,
      this.relativePath,
      fullEvents.map((event) => JSON.stringify(event)).join('\n') + '\n',
      'utf-8',
    );
    return fullEvents;
  }

  async list(tenantId: string, _sessionId: string, options: EventListOptions = {}): Promise<PlatformEvent[]> {
    this.assertTenant(tenantId);
    const events = await this.readAll();
    const excluded = new Set(options.excludeTypes);
    const included = options.includeTypes?.length ? new Set(options.includeTypes) : null;
    const selected = events.filter((event) => !excluded.has(event.type) && (!included || included.has(event.type)));
    if (options.projection === 'usage') return selected.map(projectUsageEvent);
    return options.replayMode === 'bounded' ? boundReplayToolResultEvents(selected) : selected;
  }

  async listPage(tenantId: string, _sessionId: string, options: {
    afterCursor?: string;
    limit?: number;
    runId?: string;
    type?: PlatformEvent['type'];
    excludeTypes?: PlatformEvent['type'][];
    projection?: 'usage';
  } = {}) {
    this.assertTenant(tenantId);
    const excluded = new Set(options.excludeTypes ?? []);
    const all = (await this.readAll()).filter((event) => {
      if (options.runId && (!('runId' in event) || event.runId !== options.runId)) return false;
      if (options.type && event.type !== options.type) return false;
      if (excluded.has(event.type)) return false;
      return true;
    });
    const offset = parseFileCursor(options.afterCursor);
    const limit = options.limit && options.limit > 0 ? options.limit : all.length;
    // File cursors are numeric offsets. Project the matching 1-based sequence while
    // reading so durable WS resume uses the same cursor domain as afterCursor without
    // changing the append-only JSONL format (whose persisted ids remain UUIDs).
    const page = all.slice(offset, offset + limit).map((event, index) => ({
      ...event,
      sequence: offset + index + 1,
    } as PlatformEvent & { sequence: number }));
    const nextOffset = offset + page.length;
    return {
      events: options.projection === 'usage' ? page.map(projectUsageEvent) : page,
      ...(nextOffset < all.length ? { nextCursor: String(nextOffset) } : {}),
      hasMore: nextOffset < all.length,
    };
  }

  private assertTenant(tenantId: string): void {
    if (requireTenantId(tenantId) !== this.tenantId) {
      throw new Error('FileEventStore tenant scope mismatch');
    }
  }

  private async readAll(): Promise<PlatformEvent[]> {
    // 并发去重：N 个同时进入的 list() 同文件只触发 1 次 syscall，遏制 EMFILE。
    let pending = eventReadsInFlight.get(this.cacheKey);
    if (!pending) {
      pending = readTrustedFile(this.trustedRoot, this.relativePath, 'utf-8')
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        })
        .finally(() => eventReadsInFlight.delete(this.cacheKey));
      eventReadsInFlight.set(this.cacheKey, pending);
    }
    const raw = await pending;
    if (raw === null) return [];
    const events: PlatformEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as PlatformEvent);
      } catch {
        // 保留 append-only 文件的容错：坏行不阻塞后续 replay。
      }
    }
    return events;
  }
}

function requireTenantId(tenantId: string): string {
  const normalized = tenantId.trim();
  if (!normalized) throw new Error('EventStore tenantId is required');
  return normalized;
}

function parseFileCursor(cursor?: string): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
