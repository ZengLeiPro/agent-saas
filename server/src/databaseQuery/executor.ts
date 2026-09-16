import { createHash } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';

import type {
  DatabaseConnectionRecord,
  DatabaseConnectionStore,
} from '../data/databaseConnections/index.js';
import type { SecretVault, VaultCaller } from '../security/secretVault.js';
import { ReadOnlyPolicyError, validateReadOnlySql } from './readOnlyPolicy.js';

const postgresSecretSchema = z.object({ password: z.string().min(1), ca: z.string().optional() });
const gatewaySecretSchema = z.object({ token: z.string().min(1) });
const gatewayResultSchema = z.object({
  columns: z.array(z.string()).max(500),
  rows: z.array(z.array(z.unknown())),
  truncated: z.boolean().optional(),
});

const AUTO_SENSITIVE_COLUMN =
  /(?:password|secret|token|mobile|phone|id_?card|identity|bank_?card|credit_?card)/iu;
const SAFE_PARAMETER = z.union([
  z.string().max(100_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export type DatabaseQueryErrorCode =
  | 'database_connection_not_found'
  | 'database_connection_unavailable'
  | 'database_query_rejected'
  | 'database_query_timeout'
  | 'database_query_failed'
  | 'database_result_too_large';

export class DatabaseQueryError extends Error {
  constructor(readonly code: DatabaseQueryErrorCode) {
    super(code);
    this.name = 'DatabaseQueryError';
  }
}

export interface DatabaseQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  resultBytes: number;
  sqlHash: string;
}

export interface DatabaseQueryExecutorOptions {
  store: DatabaseConnectionStore;
  vault: SecretVault;
  fetchImpl?: typeof fetch;
  statementTimeoutMs?: number;
  connectionTimeoutMs?: number;
  maxRows?: number;
  maxResultBytes?: number;
  maxConcurrentPerConnection?: number;
}

function caller(
  record: DatabaseConnectionRecord,
  operation: 'read' | 'rotate' | 'revoke',
): VaultCaller {
  const kind =
    record.engine === 'postgresql' ? 'external_database_postgresql' : 'external_database_gateway';
  return {
    actor: 'connector_proxy',
    userId: 'external_database_runtime',
    tenantId: record.tenantId,
    scopes: [`secret:${kind}:${operation}`],
  };
}

function sanitizeValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[binary:${value.byteLength}]`;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sanitizeValue(item),
      ]),
    );
  }
  return String(value);
}

function maskValue(column: string, value: unknown, configured: Set<string>): unknown {
  if (!configured.has(column.toLowerCase()) && !AUTO_SENSITIVE_COLUMN.test(column)) {
    return sanitizeValue(value);
  }
  if (typeof value === 'string' && /(?:mobile|phone)/iu.test(column) && value.length >= 7) {
    return `${value.slice(0, 3)}****${value.slice(-4)}`;
  }
  return value === null ? null : '[REDACTED]';
}

function sqlHash(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export class DatabaseQueryExecutor {
  private readonly fetchImpl: typeof fetch;
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly options: DatabaseQueryExecutorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(input: {
    connection: DatabaseConnectionRecord;
    sql: string;
    parameters?: unknown[];
    maxRows?: number;
  }): Promise<DatabaseQueryResult> {
    const connection = input.connection;
    if (connection.status !== 'ready') {
      throw new DatabaseQueryError('database_connection_unavailable');
    }
    let validated;
    try {
      validated = validateReadOnlySql(input.sql, {
        allowedSchemas: connection.allowedSchemas,
        allowedTables: connection.allowedTables,
      });
    } catch (error) {
      if (error instanceof ReadOnlyPolicyError) {
        throw new DatabaseQueryError('database_query_rejected');
      }
      throw error;
    }
    const parameters = z
      .array(SAFE_PARAMETER)
      .max(100)
      .parse(input.parameters ?? []);
    const maxRows = Math.min(Math.max(1, input.maxRows ?? 200), this.options.maxRows ?? 1_000);
    return this.withConcurrency(connection.connectionId, async () => {
      const started = Date.now();
      const raw =
        connection.engine === 'postgresql'
          ? await this.executePostgres(connection, validated.sql, parameters, maxRows)
          : await this.executeGateway(connection, validated.sql, parameters, maxRows);
      return this.limitAndMask(
        connection,
        raw.columns,
        raw.rows,
        raw.truncated,
        started,
        validated.sql,
      );
    });
  }

  async testConnection(connection: DatabaseConnectionRecord): Promise<void> {
    if (connection.engine === 'gateway') {
      const copy = {
        ...connection,
        status: 'ready' as const,
        allowedSchemas: [],
        allowedTables: [],
      };
      await this.execute({ connection: copy, sql: 'SELECT 1 AS health', maxRows: 1 });
      return;
    }
    const secret = await this.readPostgresSecret(connection);
    const pool = this.createPostgresPool(connection, secret);
    const client = await pool.connect().catch(() => {
      throw new DatabaseQueryError('database_connection_unavailable');
    });
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(
        `SET LOCAL statement_timeout = '${this.options.statementTimeoutMs ?? 5_000}ms'`,
      );
      const role = await client.query<{ elevated: boolean }>(
        `SELECT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls) AS elevated
         FROM pg_roles WHERE rolname=current_user`,
      );
      if (role.rows[0]?.elevated !== false) throw new DatabaseQueryError('database_query_rejected');
      for (const table of connection.allowedTables) {
        const access = await client.query<{ writable: boolean }>(
          `SELECT has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writable`,
          [table],
        );
        if (access.rows[0]?.writable !== false) {
          throw new DatabaseQueryError('database_query_rejected');
        }
      }
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof DatabaseQueryError) throw error;
      throw new DatabaseQueryError('database_connection_unavailable');
    } finally {
      client.release();
      await pool.end();
    }
  }

  private async executePostgres(
    connection: DatabaseConnectionRecord,
    sql: string,
    parameters: Array<string | number | boolean | null>,
    maxRows: number,
  ): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> {
    const secret = await this.readPostgresSecret(connection);
    const pool = this.createPostgresPool(connection, secret);
    const client = await pool.connect().catch(() => {
      throw new DatabaseQueryError('database_connection_unavailable');
    });
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(
        `SET LOCAL statement_timeout = '${this.options.statementTimeoutMs ?? 5_000}ms'`,
      );
      await client.query(`SET LOCAL search_path = pg_catalog`);
      const result = await client.query({
        text: `SELECT * FROM (${sql}) AS ky_agent_readonly_query LIMIT ${maxRows + 1}`,
        values: parameters,
        rowMode: 'array',
      });
      await client.query('COMMIT');
      const rows = result.rows as unknown[][];
      return {
        columns: result.fields.map((field) => field.name),
        rows: rows.slice(0, maxRows),
        truncated: rows.length > maxRows,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error && typeof error === 'object' && (error as { code?: unknown }).code === '57014') {
        throw new DatabaseQueryError('database_query_timeout');
      }
      if (error instanceof DatabaseQueryError) throw error;
      throw new DatabaseQueryError('database_query_failed');
    } finally {
      client.release();
      await pool.end();
    }
  }

  private async executeGateway(
    connection: DatabaseConnectionRecord,
    sql: string,
    parameters: Array<string | number | boolean | null>,
    maxRows: number,
  ): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> {
    if (!connection.gatewayUrl?.startsWith('https://')) {
      throw new DatabaseQueryError('database_connection_unavailable');
    }
    const secret = gatewaySecretSchema.parse(
      JSON.parse(
        await this.options.vault.getSecret(connection.secretRef, caller(connection, 'read')),
      ),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.statementTimeoutMs ?? 5_000);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(connection.gatewayUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, parameters, max_rows: maxRows + 1 }),
        signal: controller.signal,
      });
      if (!response.ok) throw new DatabaseQueryError('database_query_failed');
      const result = gatewayResultSchema.parse(await response.json());
      const rows = result.rows.slice(0, maxRows);
      return {
        columns: result.columns,
        rows,
        truncated: result.truncated === true || result.rows.length > maxRows,
      };
    } catch (error) {
      if (error instanceof DatabaseQueryError) throw error;
      if (controller.signal.aborted) throw new DatabaseQueryError('database_query_timeout');
      throw new DatabaseQueryError('database_query_failed');
    } finally {
      clearTimeout(timer);
    }
  }

  private limitAndMask(
    connection: DatabaseConnectionRecord,
    columns: string[],
    rows: unknown[][],
    truncated: boolean,
    started: number,
    sql: string,
  ): DatabaseQueryResult {
    const sensitive = new Set(connection.sensitiveColumns.map((value) => value.toLowerCase()));
    const capped: unknown[][] = [];
    const maxBytes = this.options.maxResultBytes ?? 1_048_576;
    let resultBytes = Buffer.byteLength(JSON.stringify(columns));
    for (const row of rows) {
      const masked = row.map((value, index) => maskValue(columns[index] ?? '', value, sensitive));
      const bytes = Buffer.byteLength(JSON.stringify(masked));
      if (resultBytes + bytes > maxBytes) {
        truncated = true;
        break;
      }
      capped.push(masked);
      resultBytes += bytes;
    }
    return {
      columns,
      rows: capped,
      rowCount: capped.length,
      truncated,
      durationMs: Date.now() - started,
      resultBytes,
      sqlHash: sqlHash(sql),
    };
  }

  private async readPostgresSecret(
    connection: DatabaseConnectionRecord,
  ): Promise<z.infer<typeof postgresSecretSchema>> {
    try {
      return postgresSecretSchema.parse(
        JSON.parse(
          await this.options.vault.getSecret(connection.secretRef, caller(connection, 'read')),
        ),
      );
    } catch {
      throw new DatabaseQueryError('database_connection_unavailable');
    }
  }

  private createPostgresPool(
    connection: DatabaseConnectionRecord,
    secret: z.infer<typeof postgresSecretSchema>,
  ): InstanceType<typeof pg.Pool> {
    return new pg.Pool({
      host: connection.host,
      port: connection.port,
      database: connection.databaseName,
      user: connection.username,
      password: secret.password,
      connectionTimeoutMillis: this.options.connectionTimeoutMs ?? 3_000,
      max: 1,
      ssl:
        connection.sslMode === 'disable'
          ? false
          : {
              rejectUnauthorized: connection.sslMode === 'verify-full',
              ...(secret.ca ? { ca: secret.ca } : {}),
            },
    });
  }

  private async withConcurrency<T>(connectionId: string, operation: () => Promise<T>): Promise<T> {
    const current = this.inFlight.get(connectionId) ?? 0;
    if (current >= (this.options.maxConcurrentPerConnection ?? 3)) {
      throw new DatabaseQueryError('database_connection_unavailable');
    }
    this.inFlight.set(connectionId, current + 1);
    try {
      return await operation();
    } finally {
      const next = (this.inFlight.get(connectionId) ?? 1) - 1;
      if (next <= 0) this.inFlight.delete(connectionId);
      else this.inFlight.set(connectionId, next);
    }
  }
}
