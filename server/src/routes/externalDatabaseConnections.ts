import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { isPlatformAdmin } from '../auth/types.js';
import { DatabaseQueryError, type DatabaseQueryExecutor } from '../databaseQuery/index.js';
import {
  toDatabaseConnectionView,
  type DatabaseConnectionRecord,
  type DatabaseConnectionStore,
} from '../data/databaseConnections/index.js';
import type { ExternalClientStore } from '../data/externalClients/index.js';
import { TENANT_SLUG_PATTERN } from '../data/tenants/types.js';
import { tenantOwnerId, type SecretVault, type VaultCaller } from '../security/secretVault.js';

const identifier = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_$]*$/u);
const tableName = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*$/u);
const commonSchema = z.object({
  tenantId: z.string().regex(TENANT_SLUG_PATTERN).optional(),
  name: z.string().trim().min(1).max(120),
  allowed_schemas: z.array(identifier).min(1).max(50),
  allowed_tables: z.array(tableName).min(1).max(500),
  sensitive_columns: z.array(identifier).max(100).optional(),
});
const createSchema = z.discriminatedUnion('engine', [
  commonSchema.extend({
    engine: z.literal('postgresql'),
    host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65_535).default(5432),
    database: z.string().trim().min(1).max(128),
    username: z.string().trim().min(1).max(128),
    password: z.string().min(1).max(16_384),
    ssl_mode: z.enum(['disable', 'require', 'verify-full']).default('verify-full'),
    ca: z.string().max(100_000).optional(),
  }),
  commonSchema.extend({
    engine: z.literal('gateway'),
    gateway_url: z.url().refine((url) => url.startsWith('https://'), 'gateway_url 必须使用 HTTPS'),
    token: z.string().min(1).max(16_384),
    ssl_mode: z.literal('verify-full').default('verify-full'),
  }),
]);
const rotateSchema = z.union([
  z.object({ password: z.string().min(1).max(16_384), ca: z.string().max(100_000).optional() }),
  z.object({ token: z.string().min(1).max(16_384) }),
]);
const bindSchema = z.object({ client_ids: z.array(z.string().trim().min(1).max(128)).max(100) });

export interface ExternalDatabaseConnectionsRouterDeps {
  store?: DatabaseConnectionStore;
  externalClients?: ExternalClientStore;
  vault?: SecretVault;
  executor?: DatabaseQueryExecutor;
}

function tenantIdFor(req: Request, requested?: string): string | undefined {
  if (!req.user) return undefined;
  return isPlatformAdmin(req.user) ? requested : req.user.tenantId;
}

function vaultCaller(req: Request, tenantId: string): VaultCaller {
  return {
    actor: 'connector_proxy',
    userId: req.user?.sub ?? 'external_database_admin',
    tenantId,
    scopes: [
      'secret:external_database_postgresql:write',
      'secret:external_database_postgresql:revoke',
      'secret:external_database_gateway:write',
      'secret:external_database_gateway:revoke',
    ],
  };
}

function secretValue(
  data: z.infer<typeof createSchema> | z.infer<typeof rotateSchema>,
  engine: DatabaseConnectionRecord['engine'],
): string {
  if (engine === 'postgresql' && 'password' in data) {
    return JSON.stringify({
      password: data.password,
      ...('ca' in data && data.ca ? { ca: data.ca } : {}),
    });
  }
  if (engine === 'gateway' && 'token' in data) return JSON.stringify({ token: data.token });
  throw new Error('credential_shape_invalid');
}

function unavailable(res: Response): void {
  res.status(503).json({
    error: 'Database connection service unavailable',
    code: 'database_service_unavailable',
  });
}

export function createExternalDatabaseConnectionsAdminRouter(
  deps: ExternalDatabaseConnectionsRouterDeps,
): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (!req.user) return void res.status(401).json({ error: 'Authentication required' });
    if (req.user.role !== 'admin')
      return void res.status(403).json({ error: 'Admin access required' });
    next();
  });

  router.get('/', async (req, res) => {
    if (!deps.store) return unavailable(res);
    const tenantId = tenantIdFor(
      req,
      typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined,
    );
    if (!tenantId)
      return void res.status(400).json({ error: 'tenantId required', code: 'tenant_id_required' });
    res.json({ connections: (await deps.store.list(tenantId)).map(toDatabaseConnectionView) });
  });

  router.post('/', async (req, res) => {
    if (!deps.store || !deps.vault || !deps.executor) return unavailable(res);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success)
      return void res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues });
    const tenantId = tenantIdFor(req, parsed.data.tenantId);
    if (!tenantId)
      return void res.status(400).json({ error: 'tenantId required', code: 'tenant_id_required' });
    const caller = vaultCaller(req, tenantId);
    const ref = await deps.vault.putSecret(
      tenantOwnerId(tenantId),
      parsed.data.engine === 'postgresql'
        ? 'external_database_postgresql'
        : 'external_database_gateway',
      secretValue(parsed.data, parsed.data.engine),
      caller,
      { tenantId, purpose: 'external_agent_readonly_database' },
    );
    let record: DatabaseConnectionRecord;
    try {
      record = await deps.store.create({
        tenantId,
        name: parsed.data.name,
        engine: parsed.data.engine,
        ...(parsed.data.engine === 'postgresql'
          ? {
              host: parsed.data.host,
              port: parsed.data.port,
              databaseName: parsed.data.database,
              username: parsed.data.username,
            }
          : { gatewayUrl: parsed.data.gateway_url }),
        sslMode: parsed.data.ssl_mode,
        secretRef: ref.id,
        allowedSchemas: [...new Set(parsed.data.allowed_schemas)],
        allowedTables: [...new Set(parsed.data.allowed_tables)],
        sensitiveColumns: [...new Set(parsed.data.sensitive_columns ?? [])],
        actorUserId: req.user!.sub,
      });
    } catch (error) {
      await deps.vault.revokeSecret(ref.id, caller).catch(() => undefined);
      if (error && typeof error === 'object' && (error as { code?: unknown }).code === '23505') {
        return void res
          .status(409)
          .json({ error: 'Connection name already exists', code: 'database_connection_conflict' });
      }
      throw error;
    }
    let validationError: string | undefined;
    try {
      await deps.executor.testConnection(record);
    } catch (error) {
      validationError =
        error instanceof DatabaseQueryError ? error.code : 'database_connection_unavailable';
    }
    const updated = await deps.store.updateValidation({
      connectionId: record.connectionId,
      tenantId,
      ok: validationError === undefined,
      ...(validationError ? { errorCode: validationError } : {}),
      actorUserId: req.user!.sub,
    });
    res.status(201).json({ connection: toDatabaseConnectionView(updated ?? record) });
  });

  router.post('/:connectionId/test', async (req, res) => {
    if (!deps.store || !deps.executor) return unavailable(res);
    const record = await ownedConnection(req, deps.store, req.params.connectionId);
    if (!record)
      return void res
        .status(404)
        .json({ error: 'Connection not found', code: 'database_connection_not_found' });
    try {
      await deps.executor.testConnection(record);
      const updated = await deps.store.updateValidation({
        connectionId: record.connectionId,
        tenantId: record.tenantId,
        ok: true,
        actorUserId: req.user!.sub,
      });
      res.json({ connection: toDatabaseConnectionView(updated ?? record) });
    } catch (error) {
      const code =
        error instanceof DatabaseQueryError ? error.code : 'database_connection_unavailable';
      const updated = await deps.store.updateValidation({
        connectionId: record.connectionId,
        tenantId: record.tenantId,
        ok: false,
        errorCode: code,
        actorUserId: req.user!.sub,
      });
      res.status(409).json({
        connection: toDatabaseConnectionView(updated ?? record),
        error: 'Connection validation failed',
        code,
      });
    }
  });

  router.post('/:connectionId/rotate', async (req, res) => {
    if (!deps.store || !deps.vault || !deps.executor) return unavailable(res);
    const parsed = rotateSchema.safeParse(req.body);
    if (!parsed.success)
      return void res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues });
    const record = await ownedConnection(req, deps.store, req.params.connectionId);
    if (!record)
      return void res
        .status(404)
        .json({ error: 'Connection not found', code: 'database_connection_not_found' });
    const caller = vaultCaller(req, record.tenantId);
    const next = await deps.vault.putSecret(
      tenantOwnerId(record.tenantId),
      record.engine === 'postgresql' ? 'external_database_postgresql' : 'external_database_gateway',
      secretValue(parsed.data, record.engine),
      caller,
      { tenantId: record.tenantId, rotates: record.secretRef },
    );
    try {
      await deps.executor.testConnection({ ...record, secretRef: next.id, status: 'ready' });
    } catch (error) {
      await deps.vault.revokeSecret(next.id, caller).catch(() => undefined);
      const code =
        error instanceof DatabaseQueryError ? error.code : 'database_connection_unavailable';
      return void res.status(409).json({ error: 'New credential validation failed', code });
    }
    const updated = await deps.store.replaceSecretRef({
      connectionId: record.connectionId,
      tenantId: record.tenantId,
      secretRef: next.id,
      actorUserId: req.user!.sub,
    });
    if (!updated) {
      await deps.vault.revokeSecret(next.id, caller).catch(() => undefined);
      return void res
        .status(409)
        .json({ error: 'Connection changed concurrently', code: 'database_connection_conflict' });
    }
    await deps.vault.revokeSecret(record.secretRef, caller);
    const ready = await deps.store.updateValidation({
      connectionId: record.connectionId,
      tenantId: record.tenantId,
      ok: true,
      actorUserId: req.user!.sub,
    });
    res.json({ connection: toDatabaseConnectionView(ready ?? updated) });
  });

  router.put('/:connectionId/clients', async (req, res) => {
    if (!deps.store || !deps.externalClients) return unavailable(res);
    const parsed = bindSchema.safeParse(req.body);
    if (!parsed.success)
      return void res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues });
    const record = await ownedConnection(req, deps.store, req.params.connectionId);
    if (!record)
      return void res
        .status(404)
        .json({ error: 'Connection not found', code: 'database_connection_not_found' });
    const requested = new Set(parsed.data.client_ids);
    const clients = await deps.externalClients.list(record.tenantId);
    if ([...requested].some((id) => !clients.some((client) => client.clientId === id))) {
      return void res
        .status(404)
        .json({ error: 'API Client not found', code: 'api_client_not_found' });
    }
    for (const client of clients) {
      const ids = new Set(client.allowedConnectionIds);
      if (requested.has(client.clientId)) ids.add(record.connectionId);
      else ids.delete(record.connectionId);
      await deps.externalClients.setAllowedConnectionIds({
        clientId: client.clientId,
        tenantId: record.tenantId,
        allowedConnectionIds: [...ids],
        actorUserId: req.user!.sub,
      });
    }
    res.json({ connection_id: record.connectionId, client_ids: [...requested] });
  });

  for (const [path, status] of [
    ['disable', 'disabled'],
    ['revoke', 'revoked'],
    ['delete', 'deleted'],
  ] as const) {
    router.post(`/:connectionId/${path}`, async (req, res) => {
      if (!deps.store || !deps.externalClients || !deps.vault) return unavailable(res);
      const record = await ownedConnection(req, deps.store, req.params.connectionId);
      if (!record)
        return void res
          .status(404)
          .json({ error: 'Connection not found', code: 'database_connection_not_found' });
      if (status !== 'disabled')
        await deps.vault.revokeSecret(record.secretRef, vaultCaller(req, record.tenantId));
      const updated = await deps.store.setStatus({
        connectionId: record.connectionId,
        tenantId: record.tenantId,
        status,
        actorUserId: req.user!.sub,
      });
      if (status !== 'disabled') {
        for (const client of await deps.externalClients.list(record.tenantId)) {
          if (!client.allowedConnectionIds.includes(record.connectionId)) continue;
          await deps.externalClients.setAllowedConnectionIds({
            clientId: client.clientId,
            tenantId: record.tenantId,
            allowedConnectionIds: client.allowedConnectionIds.filter(
              (id) => id !== record.connectionId,
            ),
            actorUserId: req.user!.sub,
          });
        }
      }
      res.json({ connection: toDatabaseConnectionView(updated ?? record) });
    });
  }

  return router;
}

async function ownedConnection(
  req: Request,
  store: DatabaseConnectionStore,
  connectionId: string,
): Promise<DatabaseConnectionRecord | undefined> {
  const record = await store.get(connectionId);
  if (!record || (!isPlatformAdmin(req.user) && record.tenantId !== req.user?.tenantId))
    return undefined;
  return record;
}
