import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformEvent, PlatformEventInput } from '../runtime/types.js';

const pgMock = vi.hoisted(() => {
  type QueryResult = { rows: unknown[] };
  type QueryCall = { text: string; params?: unknown[] };
  type RangeRow = { session_id: string; session_sequence: string; event_json: PlatformEvent };

  class MockConnection {
    readonly queries: QueryCall[] = [];
    readonly insertedEvents: PlatformEvent[] = [];
    startSequence = '1';
    released = false;

    async query(text: string, params?: unknown[]): Promise<QueryResult> {
      this.queries.push({ text, params });
      if (text.includes('RETURNING next_sequence - $2 AS start_sequence')) {
        return { rows: [{ start_sequence: this.startSequence }] };
      }
      if (text.includes('(session_id, session_sequence, event_id, event_type, run_id, tenant_id, timestamp, event_json)')) {
        // PR 3：INSERT 参数顺序变更，event_json 是 $8（index 7）
        this.insertedEvents.push(JSON.parse(String(params?.[7])) as PlatformEvent);
      }
      return { rows: [] };
    }

    release(): void {
      this.released = true;
    }
  }

  class MockPool {
    static instances: MockPool[] = [];

    readonly options: { connectionString?: string; max?: number };
    readonly connection = new MockConnection();
    readonly queries: QueryCall[] = [];
    readonly notifyCalls: QueryCall[] = [];
    readonly byId = new Map<string, PlatformEvent>();
    listRows: RangeRow[] = [];
    rangeRows: RangeRow[] = [];

    constructor(options: { connectionString?: string; max?: number } = {}) {
      this.options = options;
      MockPool.instances.push(this);
    }

    on(): void {}

    async connect(): Promise<MockConnection> {
      return this.connection;
    }

    async query(text: string, params?: unknown[]): Promise<QueryResult> {
      this.queries.push({ text, params });
      if (text.includes('pg_notify')) {
        this.notifyCalls.push({ text, params });
        return { rows: [] };
      }
      if (text.includes('WHERE event_id = $1')) {
        const event = this.byId.get(String(params?.[0]));
        return { rows: event ? [{ event_json: event }] : [] };
      }
      if (
        text.includes('FROM test_events')
        && text.includes('WHERE session_id = $1')
        && text.includes('ORDER BY session_sequence ASC')
        && !text.includes('session_sequence > $2')
      ) {
        const sessionId = String(params?.[0]);
        const excludeTypes = Array.isArray(params?.[1]) ? new Set(params?.[1] as string[]) : null;
        return {
          rows: this.listRows
            .filter((row) => row.session_id === sessionId)
            .filter((row) => !excludeTypes?.has(row.event_json.type))
            .sort((a, b) => Number(a.session_sequence) - Number(b.session_sequence))
            .map((row) => ({ event_json: row.event_json })),
        };
      }
      // listPage（drainSession 用）：WHERE session_id = $1 AND session_sequence > $2 ORDER BY ... LIMIT $3
      if (text.includes('AND session_sequence > $2') && !text.includes('<= $3')) {
        const sessionId = String(params?.[0]);
        const after = Number(params?.[1]);
        const limit = Number(params?.[2]);
        return {
          rows: this.rangeRows
            .filter((row) => row.session_id === sessionId && Number(row.session_sequence) > after)
            .sort((a, b) => Number(a.session_sequence) - Number(b.session_sequence))
            .slice(0, limit)
            .map((row) => ({ event_json: row.event_json, session_sequence: row.session_sequence })),
        };
      }
      return { rows: [] };
    }

    async end(): Promise<void> {}
  }

  class MockClient {
    static instances: MockClient[] = [];

    readonly queries: string[] = [];
    ended = false;
    private readonly handlers = new Map<string, (arg: unknown) => void>();

    constructor() {
      MockClient.instances.push(this);
    }

    on(event: string, handler: (arg: unknown) => void): void {
      this.handlers.set(event, handler);
    }

    removeAllListeners(event?: string): void {
      if (event) this.handlers.delete(event);
      else this.handlers.clear();
    }

    async connect(): Promise<void> {}

    async query(text: string): Promise<QueryResult> {
      this.queries.push(text);
      return { rows: [] };
    }

    async end(): Promise<void> {
      this.ended = true;
    }

    emitNotification(channel: string, payload: string): void {
      this.handlers.get('notification')?.({ channel, payload });
    }

    emitEnd(): void {
      this.handlers.get('end')?.(undefined);
    }

    emitError(err: Error): void {
      this.handlers.get('error')?.(err);
    }
  }

  return {
    MockClient,
    MockPool,
    reset() {
      MockClient.instances = [];
      MockPool.instances = [];
    },
  };
});

vi.mock('pg', () => ({
  default: {
    Client: pgMock.MockClient,
    Pool: pgMock.MockPool,
  },
}));

import {
  decodePgEventNotifyPayload,
  encodePgEventNotifyPayload,
  PgEventStore,
} from '../runtime/pgEventStore.js';

function event(id: string, sequence: number, sessionId = 'session-1'): PlatformEvent & { sequence: number } {
  return {
    id,
    timestamp: new Date(0).toISOString(),
    sequence,
    type: 'tool_output_delta',
    runId: 'run-1',
    sessionId,
    invocationId: 'inv-1',
    toolCallId: 'call-1',
    channel: 'stdout',
    content: `chunk-${sequence}`,
  } as PlatformEvent & { sequence: number };
}

function rangeRow(item: PlatformEvent & { sequence: number }) {
  return {
    session_id: item.sessionId ?? 'session-1',
    session_sequence: String(item.sequence),
    event_json: item,
  };
}

function input(content: string): PlatformEventInput {
  return {
    type: 'tool_output_delta',
    runId: 'run-1',
    sessionId: 'session-1',
    invocationId: 'inv-1',
    toolCallId: 'call-1',
    channel: 'stdout',
    content,
  };
}

const FAST_SUBSCRIBE = { reconnectDelayMs: 5, safetyPollIntervalMs: 0 } as const;

describe('PgEventStore notify coalescing', () => {
  beforeEach(() => {
    pgMock.reset();
  });

  it('caps the shared pool for blue-green overlap and allows an explicit override', () => {
    new PgEventStore({ connectionString: 'postgresql://unit-test' });
    new PgEventStore({ connectionString: 'postgresql://unit-test', poolMax: 4 });

    expect(pgMock.MockPool.instances[0]?.options.max).toBe(6);
    expect(pgMock.MockPool.instances[1]?.options.max).toBe(4);
  });

  it('encodes batch ranges and keeps legacy event-id payload compatibility', () => {
    const payload = encodePgEventNotifyPayload([
      event('event-10', 10),
      event('event-11', 11),
      event('event-12', 12),
    ]);

    expect(decodePgEventNotifyPayload(payload)).toEqual({
      kind: 'range',
      sessionId: 'session-1',
      afterCursor: '9',
      fromCursor: '10',
      toCursor: '12',
      count: 3,
    });
    expect(decodePgEventNotifyPayload('legacy-event-id')).toEqual({
      kind: 'eventId',
      eventId: 'legacy-event-id',
    });
  });

  it('emits one pg_notify for appendBatch instead of one notify per event', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    pool.connection.startSequence = '10';

    await store.appendBatch?.([input('a'), input('b'), input('c')]);

    expect(pool.connection.insertedEvents).toHaveLength(3);
    expect(pool.notifyCalls).toHaveLength(1);
    expect(decodePgEventNotifyPayload(String(pool.notifyCalls[0]?.params?.[1]))).toMatchObject({
      kind: 'range',
      sessionId: 'session-1',
      afterCursor: '9',
      fromCursor: '10',
      toCursor: '12',
      count: 3,
    });
  });

  it('init does not recreate dead runtime_events indexes', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;

    await store.init();

    const ddl = pool.connection.queries.map((call) => call.text).join('\n');
    expect(ddl).not.toContain('test_events_session_idx');
    expect(ddl).not.toContain('test_events_event_json_gin_idx');
    expect(ddl).not.toContain('test_events_run_idx');
    expect(ddl).toContain('test_events_session_run_idx');
  });

  it('list excludes replay-heavy event types when requested', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    pool.listRows = [
      rangeRow({
        id: 'event-1',
        timestamp: new Date(0).toISOString(),
        sequence: 1,
        type: 'tool_output_delta',
        runId: 'run-1',
        sessionId: 'session-1',
        invocationId: 'inv-1',
        toolCallId: 'call-1',
        content: 'chunk',
      } as PlatformEvent & { sequence: number }),
      rangeRow({
        id: 'event-2',
        timestamp: new Date(0).toISOString(),
        sequence: 2,
        type: 'assistant_message',
        runId: 'run-1',
        sessionId: 'session-1',
        content: 'done',
      } as PlatformEvent & { sequence: number }),
    ];

    const events = await store.list('session-1', { excludeTypes: ['tool_output_delta'] });

    expect(events.map((item) => item.id)).toEqual(['event-2']);
    const lastQuery = pool.queries.at(-1);
    expect(lastQuery?.text).toContain('event_type <> ALL($2::text[])');
    expect(lastQuery?.params).toEqual(['session-1', ['tool_output_delta']]);
  });

  it('drains range payloads from the durable watermark and still accepts legacy ids', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    const rangeEvents = [event('event-10', 10), event('event-11', 11), event('event-12', 12)];
    pool.rangeRows = rangeEvents.map(rangeRow);
    pool.byId.set('legacy-event-id', event('legacy-event-id', 99));

    const seen: PlatformEvent[] = [];
    const unsub = await store.subscribeAppended((item) => { seen.push(item); }, FAST_SUBSCRIBE);
    const client = pgMock.MockClient.instances[0]!;

    client.emitNotification('test_events_notify', encodePgEventNotifyPayload(rangeEvents));
    await vi.waitFor(() => {
      expect(seen.map((item) => item.id)).toEqual(['event-10', 'event-11', 'event-12']);
    });

    client.emitNotification('test_events_notify', 'legacy-event-id');
    await vi.waitFor(() => {
      expect(seen.map((item) => item.id)).toEqual(['event-10', 'event-11', 'event-12', 'legacy-event-id']);
    });

    await unsub();
  });

  it('does not re-deliver events below the consumed watermark (dedup)', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    const rangeEvents = [event('event-10', 10), event('event-11', 11), event('event-12', 12)];
    pool.rangeRows = rangeEvents.map(rangeRow);

    const seen: PlatformEvent[] = [];
    const unsub = await store.subscribeAppended((item) => { seen.push(item); }, FAST_SUBSCRIBE);
    const client = pgMock.MockClient.instances[0]!;

    const payload = encodePgEventNotifyPayload(rangeEvents);
    client.emitNotification('test_events_notify', payload);
    await vi.waitFor(() => expect(seen).toHaveLength(3));

    // 同一 NOTIFY 再来一次：水位已到 12，drain `> 12` 为空，不重复投递。
    client.emitNotification('test_events_notify', payload);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen.map((item) => item.id)).toEqual(['event-10', 'event-11', 'event-12']);

    await unsub();
  });

  it('recovers a dropped NOTIFY when the next NOTIFY drains from the watermark', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    pool.rangeRows = [event('event-10', 10)].map(rangeRow);

    const seen: PlatformEvent[] = [];
    const unsub = await store.subscribeAppended((item) => { seen.push(item); }, FAST_SUBSCRIBE);
    const client = pgMock.MockClient.instances[0]!;

    client.emitNotification('test_events_notify', encodePgEventNotifyPayload([event('event-10', 10)]));
    await vi.waitFor(() => expect(seen.map((i) => i.id)).toEqual(['event-10']));

    // 事件 11 durable 落库，但它的 NOTIFY 丢了（不 emit）。
    pool.rangeRows.push(rangeRow(event('event-11', 11)));
    // 事件 12 落库且 NOTIFY 到达 —— drain 从水位 10 之后拉，把丢掉的 11 一并补回。
    pool.rangeRows.push(rangeRow(event('event-12', 12)));
    client.emitNotification('test_events_notify', encodePgEventNotifyPayload([event('event-12', 12)]));

    await vi.waitFor(() => {
      expect(seen.map((i) => i.id)).toEqual(['event-10', 'event-11', 'event-12']);
    });

    await unsub();
  });

  it('reconnects after the listen connection drops and catches up missed events', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    pool.rangeRows = [event('event-10', 10), event('event-11', 11)].map(rangeRow);

    const seen: PlatformEvent[] = [];
    const unsub = await store.subscribeAppended((item) => { seen.push(item); }, FAST_SUBSCRIBE);
    const client0 = pgMock.MockClient.instances[0]!;

    client0.emitNotification('test_events_notify', encodePgEventNotifyPayload([event('event-10', 10), event('event-11', 11)]));
    await vi.waitFor(() => expect(seen.map((i) => i.id)).toEqual(['event-10', 'event-11']));

    // 断线窗口：事件 12/13 durable 落库，但 NOTIFY 全丢（连接已断）。
    pool.rangeRows.push(rangeRow(event('event-12', 12)));
    pool.rangeRows.push(rangeRow(event('event-13', 13)));
    client0.emitEnd();

    // 重连后自动对已跟踪会话 catch-up，补回 12/13。
    await vi.waitFor(() => {
      expect(pgMock.MockClient.instances.length).toBeGreaterThanOrEqual(2);
      expect(seen.map((i) => i.id)).toEqual(['event-10', 'event-11', 'event-12', 'event-13']);
    });
    expect(pgMock.MockClient.instances[1]!.queries.some((q) => q.includes('LISTEN'))).toBe(true);

    await unsub();
  });

  it('self-heals a dropped terminal-tail NOTIFY via the safety poll', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    pool.rangeRows = [event('event-10', 10)].map(rangeRow);

    const seen: PlatformEvent[] = [];
    const unsub = await store.subscribeAppended(
      (item) => { seen.push(item); },
      { reconnectDelayMs: 5, safetyPollIntervalMs: 15 },
    );
    const client = pgMock.MockClient.instances[0]!;

    client.emitNotification('test_events_notify', encodePgEventNotifyPayload([event('event-10', 10)]));
    await vi.waitFor(() => expect(seen.map((i) => i.id)).toEqual(['event-10']));

    // 最后一条事件 11 落库，但它的 NOTIFY 丢了且后面没有更多事件——只能靠安全轮询补。
    pool.rangeRows.push(rangeRow(event('event-11', 11)));

    await vi.waitFor(() => {
      expect(seen.map((i) => i.id)).toEqual(['event-10', 'event-11']);
    });

    await unsub();
  });
});
