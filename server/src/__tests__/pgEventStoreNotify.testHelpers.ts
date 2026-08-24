import type { PlatformEvent, PlatformEventInput } from '../runtime/types.js';

export const pgMock = (() => {
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
      if (text.includes('RETURNING next_sequence - $3 AS start_sequence')) {
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
})();

export function event(id: string, sequence: number, sessionId = 'session-1'): PlatformEvent & { sequence: number } {
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

export function rangeRow(item: PlatformEvent & { sequence: number }, globalSequence = item.sequence) {
  return {
    global_sequence: String(globalSequence),
    session_id: item.sessionId ?? 'session-1',
    session_sequence: String(item.sequence),
    tenant_id: 'tenant-1',
    event_json: item,
  };
}

export function input(content: string): PlatformEventInput {
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
