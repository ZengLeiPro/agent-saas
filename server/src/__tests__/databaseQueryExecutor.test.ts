import { describe, expect, it, vi } from 'vitest';

import { DatabaseQueryExecutor } from '../databaseQuery/executor.js';
import type {
  DatabaseConnectionRecord,
  DatabaseConnectionStore,
} from '../data/databaseConnections/index.js';
import { InMemorySecretVault, tenantOwnerId } from '../security/secretVault.js';

const noStore = {} as DatabaseConnectionStore;

function gatewayConnection(secretRef: string): DatabaseConnectionRecord {
  const now = new Date().toISOString();
  return {
    connectionId: 'dbc_gateway',
    tenantId: 'tenant-a',
    name: 'Gateway',
    engine: 'gateway',
    gatewayUrl: 'https://database.example.test/query',
    sslMode: 'verify-full',
    secretRef,
    allowedSchemas: ['reporting'],
    allowedTables: ['reporting.orders'],
    sensitiveColumns: ['email'],
    status: 'ready',
    createdAt: now,
    createdBy: 'admin',
    updatedAt: now,
    updatedBy: 'admin',
  };
}

describe('DatabaseQueryExecutor', () => {
  it('uses a server-side secret, enforces limits and masks sensitive columns', async () => {
    const vault = new InMemorySecretVault();
    const ref = await vault.putSecret(
      tenantOwnerId('tenant-a'),
      'external_database_gateway',
      JSON.stringify({ token: 'gateway-secret' }),
      {
        actor: 'connector_proxy',
        userId: 'admin',
        tenantId: 'tenant-a',
        scopes: ['secret:external_database_gateway:write'],
      },
    );
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer gateway-secret' });
      expect(JSON.parse(String(init?.body))).toMatchObject({ max_rows: 2 });
      return new Response(
        JSON.stringify({
          columns: ['id', 'email', 'phone'],
          rows: [
            [1, 'buyer@example.test', '13800138000'],
            [2, 'other@example.test', '13900139000'],
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const executor = new DatabaseQueryExecutor({ store: noStore, vault, fetchImpl, maxRows: 1 });
    const result = await executor.execute({
      connection: gatewayConnection(ref.id),
      sql: 'SELECT id,email,phone FROM reporting.orders',
      maxRows: 100,
    });
    expect(result.rows).toEqual([[1, '[REDACTED]', '138****8000']]);
    expect(result).toMatchObject({ rowCount: 1, truncated: true });
    expect(result.sqlHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects unsafe SQL before resolving credentials or sending a request', async () => {
    const vault = new InMemorySecretVault();
    const fetchImpl = vi.fn();
    const executor = new DatabaseQueryExecutor({ store: noStore, vault, fetchImpl });
    await expect(
      executor.execute({
        connection: gatewayConnection('missing'),
        sql: 'DELETE FROM reporting.orders',
      }),
    ).rejects.toMatchObject({ code: 'database_query_rejected' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
