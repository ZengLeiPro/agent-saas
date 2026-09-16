// release-migration: expand

import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import {
  databaseConnectionSchemaStatements,
  databaseConnectionTables,
  type DatabaseConnectionTables,
} from './schema.js';
import type {
  CreateDatabaseConnectionInput,
  DatabaseConnectionRecord,
  DatabaseConnectionStore,
  DatabaseQueryAuditInput,
  DatabaseQueryAuditRecord,
} from './types.js';

type PgPool = pg.Pool;

function newConnectionId(): string {
  return `dbc_${randomUUID().replaceAll('-', '')}`;
}

function rowToRecord(row: Record<string, unknown>): DatabaseConnectionRecord {
  return {
    connectionId: String(row.connection_id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    engine: row.engine as DatabaseConnectionRecord['engine'],
    ...(row.host ? { host: String(row.host) } : {}),
    ...(row.port ? { port: Number(row.port) } : {}),
    ...(row.database_name ? { databaseName: String(row.database_name) } : {}),
    ...(row.username ? { username: String(row.username) } : {}),
    ...(row.gateway_url ? { gatewayUrl: String(row.gateway_url) } : {}),
    sslMode: row.ssl_mode as DatabaseConnectionRecord['sslMode'],
    secretRef: String(row.secret_ref),
    allowedSchemas: Array.isArray(row.allowed_schemas) ? row.allowed_schemas.map(String) : [],
    allowedTables: Array.isArray(row.allowed_tables) ? row.allowed_tables.map(String) : [],
    sensitiveColumns: Array.isArray(row.sensitive_columns) ? row.sensitive_columns.map(String) : [],
    status: row.status as DatabaseConnectionRecord['status'],
    ...(row.last_tested_at
      ? { lastTestedAt: new Date(row.last_tested_at as string | Date).toISOString() }
      : {}),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
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

export class PgDatabaseConnectionStore implements DatabaseConnectionStore {
  readonly tables: DatabaseConnectionTables;
  private initialization?: Promise<void>;

  constructor(
    private readonly pool: PgPool,
    options: { tablePrefix?: string } = {},
  ) {
    this.tables = databaseConnectionTables(options.tablePrefix);
  }

  async init(): Promise<void> {
    this.initialization ??= this.initializeSchema();
    await this.initialization;
  }

  private async initializeSchema(): Promise<void> {
    const client = await this.pool.connect();
    const lockKey = `${this.tables.connections}:init`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      for (const statement of databaseConnectionSchemaStatements(this.tables)) {
        await client.query(statement);
      }
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey])
        .catch(() => undefined);
      client.release();
    }
  }

  async create(input: CreateDatabaseConnectionInput): Promise<DatabaseConnectionRecord> {
    await this.init();
    const result = await this.pool.query(
      `INSERT INTO ${this.tables.connections} (
         connection_id,tenant_id,name,engine,host,port,database_name,username,gateway_url,
         ssl_mode,secret_ref,allowed_schemas,allowed_tables,sensitive_columns,created_by,updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
       RETURNING *`,
      [
        newConnectionId(),
        input.tenantId,
        input.name,
        input.engine,
        input.host ?? null,
        input.port ?? null,
        input.databaseName ?? null,
        input.username ?? null,
        input.gatewayUrl ?? null,
        input.sslMode,
        input.secretRef,
        input.allowedSchemas,
        input.allowedTables,
        input.sensitiveColumns ?? [],
        input.actorUserId,
      ],
    );
    return rowToRecord(result.rows[0]);
  }

  async get(connectionId: string): Promise<DatabaseConnectionRecord | undefined> {
    await this.init();
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.connections} WHERE connection_id=$1`,
      [connectionId],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  }

  async list(tenantId: string): Promise<DatabaseConnectionRecord[]> {
    await this.init();
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.connections}
       WHERE tenant_id=$1 AND status<>'deleted' ORDER BY created_at DESC`,
      [tenantId],
    );
    return result.rows.map(rowToRecord);
  }

  async updateValidation(
    input: Parameters<DatabaseConnectionStore['updateValidation']>[0],
  ): Promise<DatabaseConnectionRecord | undefined> {
    await this.init();
    const result = await this.pool.query(
      `UPDATE ${this.tables.connections}
       SET status=$3,last_tested_at=NOW(),last_error_code=$4,updated_at=NOW(),updated_by=$5
       WHERE connection_id=$1 AND tenant_id=$2 AND status NOT IN ('revoked','deleted')
       RETURNING *`,
      [
        input.connectionId,
        input.tenantId,
        input.ok ? 'ready' : 'validation_failed',
        input.errorCode ?? null,
        input.actorUserId,
      ],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  }

  async replaceSecretRef(
    input: Parameters<DatabaseConnectionStore['replaceSecretRef']>[0],
  ): Promise<DatabaseConnectionRecord | undefined> {
    await this.init();
    const result = await this.pool.query(
      `UPDATE ${this.tables.connections}
       SET secret_ref=$3,status='pending',last_error_code=NULL,updated_at=NOW(),updated_by=$4
       WHERE connection_id=$1 AND tenant_id=$2 AND status NOT IN ('revoked','deleted')
       RETURNING *`,
      [input.connectionId, input.tenantId, input.secretRef, input.actorUserId],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  }

  async setStatus(
    input: Parameters<DatabaseConnectionStore['setStatus']>[0],
  ): Promise<DatabaseConnectionRecord | undefined> {
    await this.init();
    const result = await this.pool.query(
      `UPDATE ${this.tables.connections}
       SET status=$3,updated_at=NOW(),updated_by=$4,
           revoked_at=CASE WHEN $3 IN ('revoked','deleted') THEN COALESCE(revoked_at,NOW()) ELSE revoked_at END,
           revoked_by=CASE WHEN $3 IN ('revoked','deleted') THEN COALESCE(revoked_by,$4) ELSE revoked_by END
       WHERE connection_id=$1 AND tenant_id=$2 AND status<>'deleted'
       RETURNING *`,
      [input.connectionId, input.tenantId, input.status, input.actorUserId],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  }

  async recordQueryAudit(input: DatabaseQueryAuditInput): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO ${this.tables.queryAudit} (
         connection_id,tenant_id,api_client_id,conversation_id,session_id,run_id,sql_hash,
         status,duration_ms,row_count,result_bytes,truncated,error_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        input.connectionId,
        input.tenantId,
        input.apiClientId,
        input.conversationId,
        input.sessionId,
        input.runId,
        input.sqlHash,
        input.status,
        input.durationMs,
        input.rowCount,
        input.resultBytes,
        input.truncated,
        input.errorCode ?? null,
      ],
    );
  }

  async listQueryAudit(
    input: Parameters<DatabaseConnectionStore['listQueryAudit']>[0],
  ): Promise<DatabaseQueryAuditRecord[]> {
    await this.init();
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.queryAudit}
       WHERE tenant_id=$1 AND ($2::text IS NULL OR connection_id=$2)
       ORDER BY created_at DESC,audit_id DESC LIMIT $3`,
      [input.tenantId, input.connectionId ?? null, Math.min(Math.max(input.limit ?? 100, 1), 500)],
    );
    return result.rows.map((row) => ({
      auditId: String(row.audit_id),
      connectionId: String(row.connection_id),
      tenantId: String(row.tenant_id),
      apiClientId: String(row.api_client_id),
      conversationId: String(row.conversation_id),
      sessionId: String(row.session_id),
      runId: String(row.run_id),
      sqlHash: String(row.sql_hash),
      status: row.status as DatabaseQueryAuditRecord['status'],
      durationMs: Number(row.duration_ms),
      rowCount: Number(row.row_count),
      resultBytes: Number(row.result_bytes),
      truncated: Boolean(row.truncated),
      ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
      createdAt: new Date(row.created_at as string | Date).toISOString(),
    }));
  }
}
