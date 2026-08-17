import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformEvent, PlatformEventInput } from '../runtime/types.js';

const pgMock = vi.hoisted(() => {
  type QueryResult = { rows: unknown[] };
  type QueryCall = { text: string; params?: unknown[] };
  type RangeRow = {
    global_sequence: string;
    session_id: string;
    session_sequence: string;
    tenant_id: string;
    event_json: PlatformEvent;
  };

  class MockConnection {
    readonly queries: QueryCall[] = [];
    readonly insertedEvents: PlatformEvent[] = [];
    readonly existingColumns = new Set<string>();
    startSequence = '1';
    boundarySequence = '0';
    rangeRows: RangeRow[] = [];
    readonly shareLockGates: Promise<void>[] = [];
    released = false;

    async query(text: string, params?: unknown[]): Promise<QueryResult> {
      this.queries.push({ text, params });
      if (text.includes('FROM pg_attribute')) {
        return { rows: [...this.existingColumns].map((column_name) => ({ column_name })) };
      }
      if (text.includes('RETURNING next_sequence - $2 AS start_sequence')) {
        return { rows: [{ start_sequence: this.startSequence }] };
      }
      if (text.includes('LOCK TABLE') && text.includes('IN SHARE MODE')) {
        const gate = this.shareLockGates.shift();
        if (gate) await gate;
        return { rows: [] };
      }
      if (text.includes('MAX(global_sequence)')) {
        return { rows: [{ global_sequence: this.boundarySequence }] };
      }
      if (text.includes('global_sequence > $1')) {
        const hasTypeFilter = text.includes('event_type = ANY($2::text[])');
        const types = hasTypeFilter ? new Set(params?.[1] as string[]) : null;
        const limit = Number(params?.[hasTypeFilter ? 2 : 1]);
        return {
          rows: this.rangeRows
            .filter((row) => Number(row.global_sequence) > Number(params?.[0]))
            .filter((row) => !types || types.has(row.event_json.type))
            .sort((a, b) => Number(a.global_sequence) - Number(b.global_sequence))
            .slice(0, limit)
            .map((row) => (
              text.includes('session_sequence, tenant_id, session_id')
                ? row
                : { global_sequence: row.global_sequence, event_json: row.event_json }
            )),
        };
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
    listRows: RangeRow[] = [];
    rangeRows: RangeRow[] = [];
    boundarySequence = '0';
    blockNotifyQueries = false;

    constructor(options: { connectionString?: string; max?: number } = {}) {
      this.options = options;
      MockPool.instances.push(this);
    }

    on(): void {}

    async connect(): Promise<MockConnection> {
      this.connection.boundarySequence = this.boundarySequence;
      this.connection.rangeRows = this.rangeRows;
      return this.connection;
    }

    async query(text: string, params?: unknown[]): Promise<QueryResult> {
      this.queries.push({ text, params });
      if (text.includes('pg_notify')) {
        if (this.blockNotifyQueries) {
          return await new Promise<QueryResult>(() => undefined);
        }
        this.notifyCalls.push({ text, params });
        return { rows: [] };
      }
      if (text.includes('MAX(global_sequence)')) {
        return { rows: [{ global_sequence: this.boundarySequence }] };
      }
      if (text.includes('global_sequence > $1')) {
        const hasTypeFilter = text.includes('event_type = ANY($2::text[])');
        const types = hasTypeFilter ? new Set(params?.[1] as string[]) : null;
        const limit = Number(params?.[hasTypeFilter ? 2 : 1]);
        return {
          rows: this.rangeRows
            .filter((row) => Number(row.global_sequence) > Number(params?.[0]))
            .filter((row) => !types || types.has(row.event_json.type))
            .sort((a, b) => Number(a.global_sequence) - Number(b.global_sequence))
            .slice(0, limit)
            .map((row) => (
              text.includes('session_sequence, tenant_id, session_id')
                ? row
                : { global_sequence: row.global_sequence, event_json: row.event_json }
            )),
        };
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
            .map((row) => {
              if (!text.includes('AS tool_content_prefix') || row.event_json.type !== 'tool_result') {
                return { event_json: row.event_json };
              }
              const legacy = row.event_json as typeof row.event_json & { modelContent?: string };
              const { content, modelContent: _modelContent, ...eventJson } = legacy;
              const chars = Array.from(content);
              return {
                event_json: eventJson,
                tool_content_prefix: chars.slice(0, Number(params?.[4])).join(''),
                tool_content_suffix: chars.slice(-Number(params?.[5])).join(''),
                tool_content_chars: chars.length,
                tool_content_lines: content.split('\n').length,
              };
            }),
        };
      }
      // listSessionRange（NOTIFY durable range hint）：精确回读水位以下的会话范围。
      if (text.includes('AND session_sequence > $2') && text.includes('AND session_sequence <= $3')) {
        const sessionId = String(params?.[0]);
        const after = Number(params?.[1]);
        const toInclusive = Number(params?.[2]);
        const limit = Number(params?.[4]);
        return {
          rows: this.rangeRows
            .filter((row) => (
              row.session_id === sessionId
              && Number(row.session_sequence) > after
              && Number(row.session_sequence) <= toInclusive
            ))
            .sort((a, b) => Number(a.session_sequence) - Number(b.session_sequence))
            .slice(0, limit)
            .map((row) => ({ event_json: row.event_json, session_sequence: row.session_sequence })),
        };
      }
      // listPage：WHERE session_id = $1 AND session_sequence > $2 ORDER BY ... LIMIT $3
      if (text.includes('AND session_sequence > $2') && !text.includes('<= $3')) {
        const sessionId = String(params?.[0]);
        const after = Number(params?.[1]);
        const limit = Number(params?.[2]);
        const excludeTypes = Array.isArray(params?.[5]) ? new Set(params?.[5] as string[]) : null;
        return {
          rows: this.rangeRows
            .filter((row) => row.session_id === sessionId && Number(row.session_sequence) > after)
            .filter((row) => !excludeTypes?.has(row.event_json.type))
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

    static connectErrors: unknown[] = [];

    static listenGates: Promise<void>[] = [];

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

    async connect(): Promise<void> {
      const err = MockClient.connectErrors.shift();
      if (err) throw err;
    }

    async query(text: string): Promise<QueryResult> {
      this.queries.push(text);
      if (text.startsWith('LISTEN ')) {
        const gate = MockClient.listenGates.shift();
        if (gate) await gate;
      }
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
      MockClient.connectErrors = [];
      MockClient.listenGates = [];
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

function rangeRow(item: PlatformEvent & { sequence: number }, globalSequence = item.sequence) {
  return {
    global_sequence: String(globalSequence),
    session_id: item.sessionId ?? 'session-1',
    session_sequence: String(item.sequence),
    tenant_id: 'tenant-1',
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

  it('reserves event I/O capacity beyond four concurrent session locks and allows an explicit override', () => {
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
    const appendLockIndex = pool.connection.queries.findIndex((call) => call.text.includes('pg_advisory_xact_lock'));
    const firstInsertIndex = pool.connection.queries.findIndex((call) => call.text.includes('INSERT INTO test_events'));
    expect(appendLockIndex).toBeGreaterThan(pool.connection.queries.findIndex((call) => call.text === 'BEGIN'));
    expect(appendLockIndex).toBeLessThan(firstInsertIndex);
    expect(pool.connection.queries[appendLockIndex]?.params).toEqual([
      'test_events:global-sequence-commit-order',
    ]);
    const notifyCalls = pool.connection.queries.filter((call) => call.text.includes('pg_notify'));
    expect(notifyCalls).toHaveLength(1);
    expect(decodePgEventNotifyPayload(String(notifyCalls[0]?.params?.[1]))).toMatchObject({
      kind: 'range',
      sessionId: 'session-1',
      afterCursor: '9',
      fromCursor: '10',
      toCursor: '12',
      count: 3,
    });
  });

  it('does not acquire a second pool client for notify when the shared pool has no free slot', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test', poolMax: 6 });
    const pool = pgMock.MockPool.instances[0]!;
    // 复刻生产事故：3 条 session lock + 3 条并发 append 已占满 pool=6。
    // 旧实现 COMMIT 后走 pool.query(pg_notify)，这里会永久等待第二条连接。
    pool.blockNotifyQueries = true;

    const outcome = await Promise.race([
      store.appendBatch?.([input('no-nested-pool-acquire')]).then(() => 'completed'),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
    ]);

    expect(outcome).toBe('completed');
    expect(pool.queries.some((call) => call.text.includes('pg_notify'))).toBe(false);
    expect(pool.connection.queries.some((call) => call.text.includes('pg_notify'))).toBe(true);
    expect(pool.connection.released).toBe(true);
  });

  it('escapes NUL bytes before writing event_json to PostgreSQL jsonb', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;

    await store.appendBatch?.([
      input('before\u0000after'),
      input('literal\\u0000text'),
    ]);

    expect(pool.connection.insertedEvents[0]).toMatchObject({ content: 'before\\u0000after' });
    expect(pool.connection.insertedEvents[1]).toMatchObject({ content: 'literal\\u0000text' });
    expect(String((pool.connection.insertedEvents[0] as { content: string }).content)).not.toContain('\u0000');
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

  it('init skips ALTER TABLE when tenant_id already exists', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    pool.connection.existingColumns.add('tenant_id');

    await store.init();

    const ddl = pool.connection.queries.map((call) => call.text).join('\n');
    expect(ddl).toContain('FROM pg_attribute');
    expect(ddl).not.toContain('ALTER TABLE test_events');
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

  it('bounds tool_result content inside PostgreSQL before replay rows enter Node', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    const longContent = Array.from({ length: 900 }, (_, index) => `line-${index + 1}:${'x'.repeat(20)}`).join('\n');
    pool.listRows = [rangeRow({
      id: 'event-tool-result',
      timestamp: new Date(0).toISOString(),
      sequence: 1,
      type: 'tool_result',
      runId: 'run-1',
      sessionId: 'session-1',
      toolCallId: 'call-long',
      toolName: 'Shell',
      content: longContent,
    } as PlatformEvent & { sequence: number })];

    const events = await store.list('session-1', {
      replayMode: 'bounded',
      excludeTypes: ['tool_output_delta'],
    });

    const lastQuery = pool.queries.at(-1);
    expect(lastQuery?.text).not.toContain('ROW_NUMBER() OVER');
    expect(lastQuery?.text).toContain("event_json - 'content' - 'modelContent'");
    expect(lastQuery?.text).toContain("left(event_json ->> 'content', $5::integer)");
    expect(lastQuery?.text).toContain("right(event_json ->> 'content', $6::integer)");
    expect(lastQuery?.text).toContain("char_length(event_json ->> 'content')");
    expect(lastQuery?.params?.[0]).toBe('session-1');
    expect(lastQuery?.params?.[1]).toBe(false);
    expect(lastQuery?.params?.[3]).toEqual(['tool_output_delta']);
    expect(lastQuery?.params?.[4]).toBe(8_000);
    expect(lastQuery?.params?.[5]).toBe(6_000);
    expect(events[0]?.type === 'tool_result' ? events[0].content : '').toContain('line-1:');
    expect(events[0]?.type === 'tool_result' ? events[0].content : '').toContain('line-900:');
    expect(events[0]).not.toHaveProperty('modelContent');
  });

  it('filters wake-state event types in SQL instead of loading the whole session', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;

    await store.list('session-1', {
      includeTypes: ['approval_requested', 'approval_resolved'],
    });

    const lastQuery = pool.queries.at(-1);
    expect(lastQuery?.text).toContain('event_type = ANY($2::text[])');
    expect(lastQuery?.params).toEqual([
      'session-1',
      ['approval_requested', 'approval_resolved'],
      [],
    ]);
  });

  it('projects usage events without content before rows enter Node', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;

    await store.list('session-1', {
      includeTypes: ['assistant_message', 'assistant_tool_calls', 'compaction'],
      projection: 'usage',
    });

    let lastQuery = pool.queries.at(-1);
    expect(lastQuery?.text).toContain("SELECT event_json - 'content' - 'modelContent' AS event_json");
    expect(lastQuery?.text).toContain('event_type = ANY($3::text[])');
    expect(lastQuery?.params).toEqual([
      'session-1',
      true,
      ['assistant_message', 'assistant_tool_calls', 'compaction'],
      [],
    ]);

    await store.listPage?.('session-1', {
      limit: 500,
      type: 'assistant_message',
      projection: 'usage',
    });

    lastQuery = pool.queries.at(-1);
    expect(lastQuery?.text).toContain("SELECT event_json - 'content' - 'modelContent' AS event_json, session_sequence");
  });

  it('listPage 在 SQL 查询阶段排除内部事件', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    pool.rangeRows = [
      rangeRow({
        id: 'event-diagnostic',
        timestamp: new Date(0).toISOString(),
        sequence: 1,
        type: 'model_request_started',
        runId: 'run-1',
        sessionId: 'session-1',
        diagnostic: {
          type: 'started',
          modelRequestId: 'model-request-1',
          attemptId: 'attempt-1',
          attempt: 1,
          clientRequestId: 'client-1',
          model: 'gpt-5.6-sol',
          protocol: 'responses',
          responseMode: 'full',
          maxOutputTokens: 4096,
          requestBodyBytes: 100,
          toolsCount: 0,
          hasPreviousResponseId: false,
        },
      } as PlatformEvent & { sequence: number }),
      rangeRow({
        id: 'event-visible',
        timestamp: new Date(0).toISOString(),
        sequence: 2,
        type: 'assistant_message',
        runId: 'run-1',
        sessionId: 'session-1',
        content: 'done',
      } as PlatformEvent & { sequence: number }),
    ];

    const page = await store.listPage?.('session-1', {
      limit: 10,
      excludeTypes: ['model_request_started'],
    });

    expect(page?.events.map((item) => item.id)).toEqual(['event-visible']);
    const lastQuery = pool.queries.at(-1);
    expect(lastQuery?.text).toContain('event_type <> ALL($6::text[])');
    expect(lastQuery?.params?.[5]).toEqual(['model_request_started']);
  });

  it('listGlobalPage reads in BEGIN → events SHARE lock → SELECT → COMMIT order', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    pool.rangeRows = [rangeRow(event('global-page-event', 1), 7)];

    const page = await store.listGlobalPage({
      afterGlobalSequence: 0,
      types: ['tool_output_delta'],
      limit: 10,
    });

    expect(page.events).toMatchObject([{
      globalSequence: 7,
      sessionSequence: 1,
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      event: { id: 'global-page-event' },
    }]);
    const readIndex = pool.connection.queries.findIndex((call) => (
      call.text.includes('global_sequence > $1')
    ));
    expect(pool.connection.queries.slice(readIndex - 2, readIndex + 2).map((call) => call.text)).toEqual([
      'BEGIN',
      'LOCK TABLE test_events IN SHARE MODE',
      expect.stringContaining('global_sequence > $1'),
      'COMMIT',
    ]);
  });

  it('listGlobalPage waits for an uncommitted low sequence before returning a visible higher sequence', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    pool.rangeRows = [rangeRow(event('event-n-plus-1', 1, 'new-writer-session'), 2)];
    let releaseOldWriter!: () => void;
    pool.connection.shareLockGates.push(new Promise<void>((resolve) => { releaseOldWriter = resolve; }));

    let settled = false;
    const pagePromise = store.listGlobalPage({
      afterGlobalSequence: 0,
      types: ['tool_output_delta'],
      limit: 10,
    }).then((page) => {
      settled = true;
      return page;
    });

    await vi.waitFor(() => expect(pool.connection.queries.at(-1)?.text).toBe(
      'LOCK TABLE test_events IN SHARE MODE',
    ));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    pool.rangeRows.push(rangeRow(event('event-n', 1, 'old-writer-session'), 1));
    releaseOldWriter();
    const page = await pagePromise;
    expect(page.events.map((item) => item.event.id)).toEqual(['event-n', 'event-n-plus-1']);
  });

  it('starts at the durable global boundary without replaying subscription history', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    pool.boundarySequence = '40';
    pool.rangeRows = [rangeRow(event('historical-event', 1, 'historical-session'), 40)];

    const seen: PlatformEvent[] = [];
    const unsub = await store.subscribeAppended((item) => { seen.push(item); }, FAST_SUBSCRIBE);
    const boundaryReadIndex = pool.connection.queries.findIndex((call) => call.text.includes('MAX(global_sequence)'));
    expect(pool.connection.queries.slice(boundaryReadIndex - 2, boundaryReadIndex + 2).map((call) => call.text)).toEqual([
      'BEGIN',
      'LOCK TABLE test_events IN SHARE MODE',
      expect.stringContaining('MAX(global_sequence)'),
      'COMMIT',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual([]);

    pool.rangeRows.push(rangeRow(event('post-subscribe-event', 1, 'new-session'), 41));
    pgMock.MockClient.instances[0]!.emitNotification(
      'test_events_notify',
      encodePgEventNotifyPayload([event('post-subscribe-event', 1, 'new-session')]),
    );
    await vi.waitFor(() => expect(seen.map((item) => item.id)).toEqual(['post-subscribe-event']));

    await unsub();
  });

  it('treats NOTIFY payloads as pure wakes and drains only from the durable watermark', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    const rangeEvents = [event('event-10', 10), event('event-11', 11), event('event-12', 12)];
    pool.rangeRows = rangeEvents.map((item) => rangeRow(item));

    const seen: PlatformEvent[] = [];
    const unsub = await store.subscribeAppended((item) => { seen.push(item); }, FAST_SUBSCRIBE);
    const client = pgMock.MockClient.instances[0]!;

    client.emitNotification('test_events_notify', 'payload-is-not-an-exact-delivery-hint');
    await vi.waitFor(() => {
      expect(seen.map((item) => item.id)).toEqual(['event-10', 'event-11', 'event-12']);
    });

    pool.rangeRows.push(rangeRow(event('legacy-event-id', 99), 13));
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
    pool.rangeRows = rangeEvents.map((item) => rangeRow(item));

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

  it('waits at the SHARE lock for an uncommitted N instead of advancing past visible N+1', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    const seen: string[] = [];
    const unsub = await store.subscribeAppended((item) => { seen.push(item.id); }, FAST_SUBSCRIBE);
    const client = pgMock.MockClient.instances[0]!;

    // Let the initial post-LISTEN empty catch-up finish before gating the next page lock.
    await vi.waitFor(() => expect(pool.connection.queries.filter((call) => (
      call.text.includes('global_sequence > $1')
    )).length).toBeGreaterThanOrEqual(1));

    let releaseOldWriter!: () => void;
    pool.connection.shareLockGates.push(new Promise<void>((resolve) => { releaseOldWriter = resolve; }));
    // N+1 is notionally committed, but old writer N is still uncommitted. A plain SELECT would see
    // only N+1 and incorrectly advance the watermark; the SHARE lock must wait instead.
    pool.rangeRows.push(rangeRow(event('event-n-plus-1', 1, 'new-writer-session'), 2));
    client.emitNotification('test_events_notify', 'wake');

    await vi.waitFor(() => expect(pool.connection.queries.at(-1)?.text).toBe(
      'LOCK TABLE test_events IN SHARE MODE',
    ));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual([]);

    // Old writer commits N while the lock request is queued. Once granted, one locked snapshot sees
    // both rows in global order and only then may callbacks/watermark advance.
    pool.rangeRows.push(rangeRow(event('event-n', 1, 'old-writer-session'), 1));
    releaseOldWriter();
    await vi.waitFor(() => expect(seen).toEqual(['event-n', 'event-n-plus-1']));

    let pageReadIndex = -1;
    pool.connection.queries.forEach((call, index) => {
      if (call.text.includes('global_sequence > $1')) pageReadIndex = index;
    });
    expect(pool.connection.queries.slice(pageReadIndex - 2, pageReadIndex + 2).map((call) => call.text)).toEqual([
      'BEGIN',
      'LOCK TABLE test_events IN SHARE MODE',
      expect.stringContaining('global_sequence > $1'),
      'COMMIT',
    ]);
    await unsub();
  });

  it('preserves one concurrent wake across callback failure without entering a hot retry loop', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    const attempts: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let failFirst = true;
    const unsub = await store.subscribeAppended(async (item) => {
      attempts.push(item.id);
      if (failFirst) {
        failFirst = false;
        await firstGate;
        throw new Error('transient callback failure');
      }
    }, FAST_SUBSCRIBE);
    const client = pgMock.MockClient.instances[0]!;
    pool.rangeRows.push(
      rangeRow(event('retry-event', 1), 1),
      rangeRow(event('after-retry-event', 2), 2),
    );

    client.emitNotification('test_events_notify', encodePgEventNotifyPayload([event('retry-event', 1)]));
    await vi.waitFor(() => expect(attempts).toEqual(['retry-event']));
    // This wake arrives while the first callback is still in flight and sets redo=true.
    client.emitNotification('test_events_notify', encodePgEventNotifyPayload([event('after-retry-event', 2)]));
    releaseFirst();

    await vi.waitFor(() => expect(attempts).toEqual([
      'retry-event',
      'retry-event',
      'after-retry-event',
    ]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toHaveLength(3);

    await unsub();
  });

  it('uses a coalesced wake for only one retry when the callback keeps failing', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let attempts = 0;
    const unsub = await store.subscribeAppended(async () => {
      attempts += 1;
      if (attempts === 1) await firstGate;
      throw new Error('persistent callback failure');
    }, FAST_SUBSCRIBE);
    const client = pgMock.MockClient.instances[0]!;
    pool.rangeRows.push(rangeRow(event('always-fails', 1), 1));

    client.emitNotification('test_events_notify', encodePgEventNotifyPayload([event('always-fails', 1)]));
    await vi.waitFor(() => expect(attempts).toBe(1));
    client.emitNotification('test_events_notify', encodePgEventNotifyPayload([event('always-fails', 1)]));
    releaseFirst();

    await vi.waitFor(() => expect(attempts).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toBe(2);
    await unsub();
  });

  it('waits for an in-flight subscriber callback before unsubscribe resolves', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    let releaseCallback!: () => void;
    const callbackGate = new Promise<void>((resolve) => { releaseCallback = resolve; });
    let callbackStarted = false;
    const unsub = await store.subscribeAppended(async () => {
      callbackStarted = true;
      await callbackGate;
    }, FAST_SUBSCRIBE);
    pool.rangeRows.push(rangeRow(event('slow-event', 1), 1));
    pgMock.MockClient.instances[0]!.emitNotification(
      'test_events_notify',
      encodePgEventNotifyPayload([event('slow-event', 1)]),
    );
    await vi.waitFor(() => expect(callbackStarted).toBe(true));

    let unsubscribeSettled = false;
    const unsubscribePromise = unsub().then(() => { unsubscribeSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unsubscribeSettled).toBe(false);

    releaseCallback();
    await unsubscribePromise;
    expect(unsubscribeSettled).toBe(true);
  });

  it('unsubscribe waits for an in-flight reconnect LISTEN and tears down the late client', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const unsub = await store.subscribeAppended(() => undefined, FAST_SUBSCRIBE);
    const firstClient = pgMock.MockClient.instances[0]!;
    let releaseListen!: () => void;
    pgMock.MockClient.listenGates.push(new Promise<void>((resolve) => { releaseListen = resolve; }));

    firstClient.emitEnd();
    await vi.waitFor(() => {
      expect(pgMock.MockClient.instances).toHaveLength(2);
      expect(pgMock.MockClient.instances[1]!.queries).toContain('LISTEN test_events_notify');
    });

    let settled = false;
    const unsubscribePromise = unsub().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    releaseListen();
    await unsubscribePromise;
    expect(settled).toBe(true);
    expect(pgMock.MockClient.instances[1]!.ended).toBe(true);
  });

  it('recovers a dropped NOTIFY when the next NOTIFY drains from the watermark', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    pool.rangeRows = [event('event-10', 10)].map((item) => rangeRow(item));

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

  it('defers an initial 53300 listener failure and reconnects without blocking startup', async () => {
    const capacityError = Object.assign(new Error('too many connections'), { code: '53300' });
    pgMock.MockClient.connectErrors.push(capacityError);
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });

    const unsub = await store.subscribeAppended(() => undefined, FAST_SUBSCRIBE);

    await vi.waitFor(() => {
      expect(pgMock.MockClient.instances.length).toBeGreaterThanOrEqual(2);
      expect(pgMock.MockClient.instances[1]!.queries.some((q) => q.includes('LISTEN'))).toBe(true);
    });
    expect(pgMock.MockClient.instances[0]!.ended).toBe(true);

    await unsub();
  });

  it('still rejects non-capacity errors during the initial listener connection', async () => {
    const authError = Object.assign(new Error('password authentication failed'), { code: '28P01' });
    pgMock.MockClient.connectErrors.push(authError);
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });

    await expect(store.subscribeAppended(() => undefined, FAST_SUBSCRIBE)).rejects.toBe(authError);
  });

  it('reconnects after the listen connection drops and catches up missed events', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    pool.rangeRows = [event('event-10', 10), event('event-11', 11)].map((item) => rangeRow(item));

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

  it('catches up a first-seen session created while LISTEN is disconnected without duplicates', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    const seen: PlatformEvent[] = [];
    const unsub = await store.subscribeAppended((item) => { seen.push(item); }, FAST_SUBSCRIBE);
    const client0 = pgMock.MockClient.instances[0]!;

    client0.emitEnd();
    // 断线窗口内首次出现的新 session；它的所有 NOTIFY 都丢失，旧 per-session 水位无法发现它。
    pool.rangeRows.push(
      rangeRow(event('new-session-1', 1, 'session-created-offline'), 1),
      rangeRow(event('new-session-2', 2, 'session-created-offline'), 2),
    );

    await vi.waitFor(() => {
      expect(pgMock.MockClient.instances.length).toBeGreaterThanOrEqual(2);
      expect(seen.map((item) => item.id)).toEqual(['new-session-1', 'new-session-2']);
    });

    // 重复重连 catch-up / 后续 NOTIFY 都只扫描全局水位之后，不重投已交付事件。
    pgMock.MockClient.instances[1]!.emitNotification(
      'test_events_notify',
      encodePgEventNotifyPayload([event('new-session-1', 1, 'session-created-offline')]),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen.map((item) => item.id)).toEqual(['new-session-1', 'new-session-2']);

    await unsub();
  });

  it('self-heals a dropped terminal-tail NOTIFY via the safety poll', async () => {
    const store = new PgEventStore({ connectionString: 'postgresql://unit-test', tablePrefix: 'test' });
    const pool = pgMock.MockPool.instances[0]!;
    pool.rangeRows = [event('event-10', 10)].map((item) => rangeRow(item));

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
