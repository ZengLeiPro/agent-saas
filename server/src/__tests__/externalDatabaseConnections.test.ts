import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '../auth/types.js';
import type {
  DatabaseConnectionRecord,
  DatabaseConnectionStore,
  DatabaseQueryAuditInput,
} from '../data/databaseConnections/index.js';
import { InMemoryExternalClientStore } from '../data/externalClients/index.js';
import { createExternalDatabaseConnectionsAdminRouter } from '../routes/externalDatabaseConnections.js';
import { InMemorySecretVault } from '../security/secretVault.js';

class MemoryConnectionStore implements DatabaseConnectionStore {
  readonly records = new Map<string, DatabaseConnectionRecord>();
  async create(input: Parameters<DatabaseConnectionStore['create']>[0]) {
    const now = new Date().toISOString();
    const record: DatabaseConnectionRecord = {
      connectionId: 'dbc-1',
      tenantId: input.tenantId,
      name: input.name,
      engine: input.engine,
      ...(input.host ? { host: input.host } : {}),
      ...(input.port ? { port: input.port } : {}),
      ...(input.databaseName ? { databaseName: input.databaseName } : {}),
      ...(input.username ? { username: input.username } : {}),
      ...(input.gatewayUrl ? { gatewayUrl: input.gatewayUrl } : {}),
      sslMode: input.sslMode,
      secretRef: input.secretRef,
      allowedSchemas: input.allowedSchemas,
      allowedTables: input.allowedTables,
      sensitiveColumns: input.sensitiveColumns ?? [],
      status: 'pending',
      createdAt: now,
      createdBy: input.actorUserId,
      updatedAt: now,
      updatedBy: input.actorUserId,
    };
    this.records.set(record.connectionId, record);
    return record;
  }
  async get(id: string) {
    return this.records.get(id);
  }
  async list(tenantId: string) {
    return [...this.records.values()].filter(
      (item) => item.tenantId === tenantId && item.status !== 'deleted',
    );
  }
  async updateValidation(input: Parameters<DatabaseConnectionStore['updateValidation']>[0]) {
    const record = this.records.get(input.connectionId);
    if (!record || record.tenantId !== input.tenantId) return undefined;
    const next = {
      ...record,
      status: input.ok ? ('ready' as const) : ('validation_failed' as const),
      ...(input.errorCode ? { lastErrorCode: input.errorCode } : {}),
    };
    this.records.set(record.connectionId, next);
    return next;
  }
  async replaceSecretRef(input: Parameters<DatabaseConnectionStore['replaceSecretRef']>[0]) {
    const record = this.records.get(input.connectionId);
    if (!record) return undefined;
    const next = { ...record, secretRef: input.secretRef, status: 'pending' as const };
    this.records.set(record.connectionId, next);
    return next;
  }
  async setStatus(input: Parameters<DatabaseConnectionStore['setStatus']>[0]) {
    const record = this.records.get(input.connectionId);
    if (!record) return undefined;
    const next = { ...record, status: input.status };
    this.records.set(record.connectionId, next);
    return next;
  }
  async recordQueryAudit(_input: DatabaseQueryAuditInput) {}
}

let server: Server;
let baseUrl: string;
let store: MemoryConnectionStore;
let clients: InMemoryExternalClientStore;
const admin: JwtPayload = {
  sub: 'admin-a',
  username: 'admin-a',
  role: 'admin',
  tenantId: 'tenant-a',
};

beforeEach(async () => {
  store = new MemoryConnectionStore();
  clients = new InMemoryExternalClientStore();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = admin;
    next();
  });
  app.use(
    '/api/admin/external-database-connections',
    createExternalDatabaseConnectionsAdminRouter({
      store,
      externalClients: clients,
      vault: new InMemorySecretVault(),
      executor: { testConnection: vi.fn(async () => undefined) } as never,
    }),
  );
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('not listening');
  baseUrl = `http://127.0.0.1:${address.port}/api/admin/external-database-connections`;
});

afterEach(
  async () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
);

describe('external database connection admin API', () => {
  it('stores the credential in SecretVault and never returns it', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '客户报表库',
        engine: 'postgresql',
        host: 'db.internal',
        port: 5432,
        database: 'reporting',
        username: 'readonly_user',
        password: 'super-secret',
        ssl_mode: 'require',
        allowed_schemas: ['reporting'],
        allowed_tables: ['reporting.orders'],
        sensitive_columns: ['email'],
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, any>;
    expect(body.connection).toMatchObject({
      connectionId: 'dbc-1',
      tenantId: 'tenant-a',
      status: 'ready',
      credentialConfigured: true,
    });
    expect(JSON.stringify(body)).not.toContain('super-secret');
    expect(body.connection).not.toHaveProperty('secretRef');
  });

  it('binds the connection to selected active API clients', async () => {
    const client = await clients.create({
      tenantId: 'tenant-a',
      serviceAccountUserId: 'svc-1',
      name: 'ERP',
      keyHash: 'hash',
      keyPrefix: 'prefix',
      scopes: ['conversations:write'],
      actorUserId: 'admin-a',
    });
    await store.create({
      tenantId: 'tenant-a',
      name: 'Gateway',
      engine: 'gateway',
      gatewayUrl: 'https://gateway.example.test/query',
      sslMode: 'verify-full',
      secretRef: 'secret-1',
      allowedSchemas: ['reporting'],
      allowedTables: ['reporting.orders'],
      actorUserId: 'admin-a',
    });
    const response = await fetch(`${baseUrl}/dbc-1/clients`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_ids: [client.clientId] }),
    });
    expect(response.status).toBe(200);
    await expect(clients.get(client.clientId)).resolves.toMatchObject({
      allowedConnectionIds: ['dbc-1'],
    });
  });
});
