// release-migration: expand

import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import type {
  CreateExternalClientInput,
  ExternalClientRecord,
  ExternalClientScope,
  ExternalClientStore,
} from './types.js';
import { externalClientSchemaStatements } from './schema.js';

type PgPool = pg.Pool;

function clone(record: ExternalClientRecord): ExternalClientRecord {
  return {
    ...record,
    scopes: [...record.scopes],
    allowedConnectionIds: [...record.allowedConnectionIds],
  };
}

function newClientId(): string {
  return `apic_${randomUUID().replaceAll('-', '')}`;
}

function rowToRecord(row: Record<string, unknown>): ExternalClientRecord {
  return {
    clientId: String(row.client_id),
    tenantId: String(row.tenant_id),
    serviceAccountUserId: String(row.service_account_user_id),
    name: String(row.name),
    keyHash: String(row.key_hash),
    keyPrefix: String(row.key_prefix),
    scopes: Array.isArray(row.scopes) ? (row.scopes.map(String) as ExternalClientScope[]) : [],
    allowedConnectionIds: Array.isArray(row.allowed_connection_ids)
      ? row.allowed_connection_ids.map(String)
      : [],
    status: row.status as ExternalClientRecord['status'],
    ...(row.expires_at
      ? { expiresAt: new Date(row.expires_at as string | Date).toISOString() }
      : {}),
    ...(row.last_used_at
      ? { lastUsedAt: new Date(row.last_used_at as string | Date).toISOString() }
      : {}),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    createdBy: String(row.created_by),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    updatedBy: String(row.updated_by),
    ...(row.revoked_at
      ? { revokedAt: new Date(row.revoked_at as string | Date).toISOString() }
      : {}),
    ...(row.revoked_by ? { revokedBy: String(row.revoked_by) } : {}),
  };
}

export class InMemoryExternalClientStore implements ExternalClientStore {
  private readonly records = new Map<string, ExternalClientRecord>();

  async create(input: CreateExternalClientInput): Promise<ExternalClientRecord> {
    const now = new Date().toISOString();
    const record: ExternalClientRecord = {
      clientId: newClientId(),
      tenantId: input.tenantId,
      serviceAccountUserId: input.serviceAccountUserId,
      name: input.name,
      keyHash: input.keyHash,
      keyPrefix: input.keyPrefix,
      scopes: [...input.scopes],
      allowedConnectionIds: [...(input.allowedConnectionIds ?? [])],
      status: 'active',
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      createdAt: now,
      createdBy: input.actorUserId,
      updatedAt: now,
      updatedBy: input.actorUserId,
    };
    this.records.set(record.clientId, record);
    return clone(record);
  }

  async get(clientId: string): Promise<ExternalClientRecord | undefined> {
    const record = this.records.get(clientId);
    return record ? clone(record) : undefined;
  }

  async list(tenantId?: string): Promise<ExternalClientRecord[]> {
    return [...this.records.values()]
      .filter((record) => tenantId === undefined || record.tenantId === tenantId)
      .sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || a.clientId.localeCompare(b.clientId),
      )
      .map(clone);
  }

  async findByKeyHash(keyHash: string): Promise<ExternalClientRecord | undefined> {
    const record = [...this.records.values()].find((candidate) => candidate.keyHash === keyHash);
    return record ? clone(record) : undefined;
  }

  async rotateKey(input: {
    clientId: string;
    keyHash: string;
    keyPrefix: string;
    actorUserId: string;
  }): Promise<ExternalClientRecord | undefined> {
    const record = this.records.get(input.clientId);
    if (!record || record.status !== 'active') return undefined;
    const updated: ExternalClientRecord = {
      ...record,
      keyHash: input.keyHash,
      keyPrefix: input.keyPrefix,
      updatedAt: new Date().toISOString(),
      updatedBy: input.actorUserId,
    };
    this.records.set(input.clientId, updated);
    return clone(updated);
  }

  async revoke(input: {
    clientId: string;
    actorUserId: string;
  }): Promise<ExternalClientRecord | undefined> {
    const record = this.records.get(input.clientId);
    if (!record) return undefined;
    if (record.status === 'revoked') return clone(record);
    const now = new Date().toISOString();
    const updated: ExternalClientRecord = {
      ...record,
      status: 'revoked',
      revokedAt: now,
      revokedBy: input.actorUserId,
      updatedAt: now,
      updatedBy: input.actorUserId,
    };
    this.records.set(input.clientId, updated);
    return clone(updated);
  }

  async touchLastUsed(clientId: string, usedAt: string): Promise<void> {
    const record = this.records.get(clientId);
    if (!record) return;
    this.records.set(clientId, { ...record, lastUsedAt: usedAt });
  }
}

function safeIdentifier(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_]/g, '_');
  if (!normalized || !/^[a-zA-Z_]/.test(normalized)) return `runtime_${normalized}`;
  return normalized;
}

export class PgExternalClientStore implements ExternalClientStore {
  readonly table: string;
  private initialization?: Promise<void>;

  constructor(
    private readonly pool: PgPool,
    options: { tablePrefix?: string } = {},
  ) {
    this.table = `${safeIdentifier(options.tablePrefix ?? 'runtime')}_external_api_clients`;
  }

  async init(): Promise<void> {
    this.initialization ??= this.initializeSchema();
    await this.initialization;
  }

  private async initializeSchema(): Promise<void> {
    const client = await this.pool.connect();
    const lockKey = `${this.table}:init`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      for (const statement of externalClientSchemaStatements(this.table))
        await client.query(statement);
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey])
        .catch(() => undefined);
      client.release();
    }
  }

  async create(input: CreateExternalClientInput): Promise<ExternalClientRecord> {
    await this.init();
    const now = new Date();
    const result = await this.pool.query(
      `
      INSERT INTO ${this.table} (
        client_id, tenant_id, service_account_user_id, name, key_hash, key_prefix,
        scopes, allowed_connection_ids, status, expires_at,
        created_at, created_by, updated_at, updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11,$10,$11)
      RETURNING *
    `,
      [
        newClientId(),
        input.tenantId,
        input.serviceAccountUserId,
        input.name,
        input.keyHash,
        input.keyPrefix,
        input.scopes,
        input.allowedConnectionIds ?? [],
        input.expiresAt ?? null,
        now,
        input.actorUserId,
      ],
    );
    return rowToRecord(result.rows[0]);
  }

  async get(clientId: string): Promise<ExternalClientRecord | undefined> {
    await this.init();
    const result = await this.pool.query(`SELECT * FROM ${this.table} WHERE client_id=$1`, [
      clientId,
    ]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  }

  async list(tenantId?: string): Promise<ExternalClientRecord[]> {
    await this.init();
    const result = await this.pool.query(
      `SELECT * FROM ${this.table} WHERE ($1::text IS NULL OR tenant_id=$1) ORDER BY created_at DESC, client_id`,
      [tenantId ?? null],
    );
    return result.rows.map(rowToRecord);
  }

  async findByKeyHash(keyHash: string): Promise<ExternalClientRecord | undefined> {
    await this.init();
    const result = await this.pool.query(`SELECT * FROM ${this.table} WHERE key_hash=$1`, [
      keyHash,
    ]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  }

  async rotateKey(input: {
    clientId: string;
    keyHash: string;
    keyPrefix: string;
    actorUserId: string;
  }): Promise<ExternalClientRecord | undefined> {
    await this.init();
    const result = await this.pool.query(
      `
      UPDATE ${this.table}
      SET key_hash=$2, key_prefix=$3, updated_at=NOW(), updated_by=$4
      WHERE client_id=$1 AND status='active'
      RETURNING *
    `,
      [input.clientId, input.keyHash, input.keyPrefix, input.actorUserId],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  }

  async revoke(input: {
    clientId: string;
    actorUserId: string;
  }): Promise<ExternalClientRecord | undefined> {
    await this.init();
    const result = await this.pool.query(
      `
      UPDATE ${this.table}
      SET status='revoked', revoked_at=COALESCE(revoked_at,NOW()), revoked_by=COALESCE(revoked_by,$2),
          updated_at=CASE WHEN status='active' THEN NOW() ELSE updated_at END,
          updated_by=CASE WHEN status='active' THEN $2 ELSE updated_by END
      WHERE client_id=$1
      RETURNING *
    `,
      [input.clientId, input.actorUserId],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  }

  async touchLastUsed(clientId: string, usedAt: string): Promise<void> {
    await this.init();
    await this.pool.query(`UPDATE ${this.table} SET last_used_at=$2 WHERE client_id=$1`, [
      clientId,
      usedAt,
    ]);
  }
}
