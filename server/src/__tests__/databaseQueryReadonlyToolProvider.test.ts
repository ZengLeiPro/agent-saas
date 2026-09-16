import { describe, expect, it, vi } from 'vitest';

import { DatabaseQueryReadonlyToolProvider } from '../agent/databaseQueryReadonlyToolProvider.js';
import type { ToolCallContext } from '../agent/toolRuntime.js';
import type {
  DatabaseConnectionRecord,
  DatabaseConnectionStore,
  DatabaseQueryAuditInput,
} from '../data/databaseConnections/index.js';

const now = new Date().toISOString();
const connection: DatabaseConnectionRecord = {
  connectionId: 'dbc-1',
  tenantId: 'tenant-a',
  name: 'Reporting',
  engine: 'gateway',
  gatewayUrl: 'https://database.example.test/query',
  sslMode: 'verify-full',
  secretRef: 'secret-1',
  allowedSchemas: ['reporting'],
  allowedTables: ['reporting.orders'],
  sensitiveColumns: [],
  status: 'ready',
  createdAt: now,
  createdBy: 'admin',
  updatedAt: now,
  updatedBy: 'admin',
};

function context(overrides: Partial<ToolCallContext['externalApi']> = {}): ToolCallContext {
  return {
    channelContext: {} as never,
    workspace: { root: '/tmp/workspace', tenantId: 'tenant-a', executionTarget: 'server-local' },
    sessionId: 'session-1',
    runId: 'run-1',
    externalApi: {
      apiClientId: 'client-1',
      conversationId: 'conversation-1',
      externalConversationId: 'erp-1',
      databaseConnectionId: 'dbc-1',
      metadata: {},
      ...overrides,
    },
  };
}

describe('DatabaseQueryReadonlyToolProvider', () => {
  it('is invisible outside a trusted external session', () => {
    const provider = new DatabaseQueryReadonlyToolProvider({} as never);
    expect(provider.list()).toEqual([]);
    expect(provider.list({ ...context(), externalApi: undefined })).toEqual([]);
    expect(provider.list(context())).toHaveLength(1);
  });

  it('rechecks current tenant and client binding, then records only a SQL hash', async () => {
    const audits: DatabaseQueryAuditInput[] = [];
    const store = {
      get: vi.fn(async () => connection),
      recordQueryAudit: vi.fn(async (input: DatabaseQueryAuditInput) => {
        audits.push(input);
      }),
    } as unknown as DatabaseConnectionStore;
    const externalClients = {
      get: vi.fn(async () => ({
        clientId: 'client-1',
        tenantId: 'tenant-a',
        status: 'active',
        allowedConnectionIds: ['dbc-1'],
      })),
    };
    const executor = {
      execute: vi.fn(async () => ({
        columns: ['total'],
        rows: [[42]],
        rowCount: 1,
        truncated: false,
        durationMs: 3,
        resultBytes: 12,
        sqlHash: 'a'.repeat(64),
      })),
    };
    const provider = new DatabaseQueryReadonlyToolProvider({
      store,
      externalClients: externalClients as never,
      executor: executor as never,
    });
    const result = await provider.invoke(
      {
        toolId: 'DatabaseQueryReadonly',
        input: { sql: 'SELECT total FROM reporting.orders' },
        authorization: { approved: true, source: 'policy_auto' },
      },
      context(),
    );
    expect(JSON.parse(result!.content)).toMatchObject({ rows: [[42]], row_count: 1 });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ sqlHash: 'a'.repeat(64), status: 'completed' });
    expect(audits[0]).not.toHaveProperty('sql');

    externalClients.get.mockResolvedValueOnce({
      clientId: 'client-1',
      tenantId: 'tenant-a',
      status: 'active',
      allowedConnectionIds: [],
    });
    await expect(
      provider.invoke(
        {
          toolId: 'DatabaseQueryReadonly',
          input: { sql: 'SELECT total FROM reporting.orders' },
          authorization: { approved: true, source: 'policy_auto' },
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'database_connection_not_found' });
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
});
