import { randomUUID } from 'crypto';
import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

import { readFileCoalesce } from './fileReadCoalesce.js';
import type { EventAppendContext, EventListOptions, EventStore, PlatformEvent, PlatformEventInput } from './types.js';

export function getRuntimeEventLogPath(transcriptPath: string): string {
  return transcriptPath.endsWith('.jsonl')
    ? transcriptPath.slice(0, -'.jsonl'.length) + '.runtime-events.jsonl'
    : `${transcriptPath}.runtime-events.jsonl`;
}

export class FileEventStore implements EventStore {
  constructor(private readonly filePath: string) {}

  async append(event: PlatformEventInput, ctx?: EventAppendContext): Promise<PlatformEvent> {
    return (await this.appendBatch([event], ctx))[0]!;
  }

  async appendBatch(events: PlatformEventInput[], _ctx?: EventAppendContext): Promise<PlatformEvent[]> {
    // File backend 不存 tenantId（jsonl 旁路文件物理路径隔离已足够）；ctx 仅为
    // 满足 EventStore 接口形态，便于调用方统一签名。
    if (events.length === 0) return [];
    const timestamp = new Date().toISOString();
    const fullEvents = events.map((event) => ({
      id: randomUUID(),
      timestamp,
      ...event,
    } as PlatformEvent));
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, fullEvents.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf-8');
    return fullEvents;
  }

  async list(_sessionId: string, options: EventListOptions = {}): Promise<PlatformEvent[]> {
    const events = await this.readAll();
    if (!options.excludeTypes?.length) return events;
    const excluded = new Set(options.excludeTypes);
    return events.filter((event) => !excluded.has(event.type));
  }

  async listPage(_sessionId: string, options: {
    afterCursor?: string;
    limit?: number;
    runId?: string;
    type?: PlatformEvent['type'];
    excludeTypes?: PlatformEvent['type'][];
  } = {}) {
    const excluded = new Set(options.excludeTypes ?? []);
    const all = (await this.readAll()).filter((event) => {
      if (options.runId && (!('runId' in event) || event.runId !== options.runId)) return false;
      if (options.type && event.type !== options.type) return false;
      if (excluded.has(event.type)) return false;
      return true;
    });
    const offset = parseFileCursor(options.afterCursor);
    const limit = options.limit && options.limit > 0 ? options.limit : all.length;
    const page = all.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      events: page,
      ...(nextOffset < all.length ? { nextCursor: String(nextOffset) } : {}),
      hasMore: nextOffset < all.length,
    };
  }

  private async readAll(): Promise<PlatformEvent[]> {
    // 并发去重：N 个同时进入的 list() 同文件只触发 1 次 syscall，遏制 EMFILE。
    const raw = await readFileCoalesce(this.filePath);
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

function parseFileCursor(cursor?: string): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
