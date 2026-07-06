import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import { DEFAULT_TENANT_ID, LEGACY_TENANT_ID } from '../data/tenants/types.js';

export type ToolInvocationStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface ToolInvocationRecord {
  invocationId: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  executionTarget: ExecutionTargetKind;
  tenantId?: string;
  status: ToolInvocationStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelRequestedAt?: string;
  cancelReason?: string;
  cancelDeliveredAt?: string;
  error?: string;
  metadata: Record<string, unknown>;
}

export interface StartToolInvocationInput {
  invocationId: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  executionTarget: ExecutionTargetKind;
  tenantId?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolInvocationStore {
  start(input: StartToolInvocationInput): Promise<ToolInvocationRecord>;
  complete(invocationId: string, status: Exclude<ToolInvocationStatus, 'running'>, error?: string): Promise<ToolInvocationRecord | null>;
  requestCancel(invocationId: string, reason?: string, metadataPatch?: Record<string, unknown>): Promise<ToolInvocationRecord | null>;
  markCancelDeliveryAttempt(invocationId: string, metadataPatch?: Record<string, unknown>): Promise<ToolInvocationRecord | null>;
  markCancelDelivered(invocationId: string, metadataPatch?: Record<string, unknown>): Promise<ToolInvocationRecord | null>;
  get(invocationId: string): Promise<ToolInvocationRecord | null>;
  listRunning(sessionId?: string): Promise<ToolInvocationRecord[]>;
  listCancelRequested(sessionId?: string): Promise<ToolInvocationRecord[]>;
}

export class InMemoryToolInvocationStore implements ToolInvocationStore {
  private readonly invocations = new Map<string, ToolInvocationRecord>();

  async start(input: StartToolInvocationInput): Promise<ToolInvocationRecord> {
    const now = new Date().toISOString();
    const record: ToolInvocationRecord = {
      invocationId: input.invocationId,
      runId: input.runId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      executionTarget: input.executionTarget,
      tenantId: input.tenantId,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      metadata: input.metadata ?? {},
    };
    this.invocations.set(input.invocationId, record);
    return record;
  }

  async complete(invocationId: string, status: Exclude<ToolInvocationStatus, 'running'>, error?: string): Promise<ToolInvocationRecord | null> {
    const record = this.invocations.get(invocationId);
    if (!record || record.status !== 'running') return null;
    const updated: ToolInvocationRecord = {
      ...record,
      status,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      ...(error ? { error } : {}),
    };
    this.invocations.set(invocationId, updated);
    return updated;
  }

  async requestCancel(invocationId: string, reason?: string, metadataPatch: Record<string, unknown> = {}): Promise<ToolInvocationRecord | null> {
    const record = this.invocations.get(invocationId);
    if (!record || record.status !== 'running') return null;
    const updated: ToolInvocationRecord = {
      ...record,
      cancelRequestedAt: new Date().toISOString(),
      cancelReason: reason,
      updatedAt: new Date().toISOString(),
      metadata: { ...record.metadata, ...metadataPatch },
    };
    this.invocations.set(invocationId, updated);
    return updated;
  }

  async markCancelDeliveryAttempt(invocationId: string, metadataPatch: Record<string, unknown> = {}): Promise<ToolInvocationRecord | null> {
    const record = this.invocations.get(invocationId);
    if (!record) return null;
    const updated: ToolInvocationRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
      metadata: { ...record.metadata, ...metadataPatch },
    };
    this.invocations.set(invocationId, updated);
    return updated;
  }

  async markCancelDelivered(invocationId: string, metadataPatch: Record<string, unknown> = {}): Promise<ToolInvocationRecord | null> {
    const record = this.invocations.get(invocationId);
    if (!record) return null;
    const updated: ToolInvocationRecord = {
      ...record,
      cancelDeliveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { ...record.metadata, ...metadataPatch },
    };
    this.invocations.set(invocationId, updated);
    return updated;
  }

  async get(invocationId: string): Promise<ToolInvocationRecord | null> {
    return this.invocations.get(invocationId) ?? null;
  }

  async listRunning(sessionId?: string): Promise<ToolInvocationRecord[]> {
    return [...this.invocations.values()]
      .filter((record) => record.status === 'running')
      .filter((record) => !sessionId || record.sessionId === sessionId);
  }

  async listCancelRequested(sessionId?: string): Promise<ToolInvocationRecord[]> {
    return [...this.invocations.values()]
      .filter((record) => record.status === 'running' && record.cancelRequestedAt && !record.cancelDeliveredAt)
      .filter((record) => !sessionId || record.sessionId === sessionId);
  }
}

export interface PgToolInvocationStoreOptions {
  pool: import('pg').Pool;
  tablePrefix?: string;
}

export class PgToolInvocationStore implements ToolInvocationStore {
  private readonly table: string;

  constructor(private readonly options: PgToolInvocationStoreOptions) {
    this.table = `${sanitizeIdentifier(options.tablePrefix ?? 'runtime')}_tool_invocations`;
  }

  async init(): Promise<void> {
    await this.options.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        invocation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        execution_target TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        cancel_requested_at TIMESTAMPTZ,
        cancel_reason TEXT,
        cancel_delivered_at TIMESTAMPTZ,
        error TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await this.options.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ`);
    await this.options.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS cancel_reason TEXT`);
    await this.options.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS cancel_delivered_at TIMESTAMPTZ`);
    // PR 3：多组织改造 — 加 tenant_id 列。旧 invocation 回填 LEGACY_TENANT_ID；
    // 新 invocation 由调用方传入或走平台根 fallback。
    await this.options.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT_ID}'`);
    await this.options.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_session_idx ON ${this.table} (session_id)`);
    await this.options.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_run_idx ON ${this.table} (run_id)`);
    await this.options.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_status_idx ON ${this.table} (status)`);
    await this.options.pool.query(`CREATE INDEX IF NOT EXISTS ${this.table}_tenant_idx ON ${this.table} (tenant_id, started_at DESC)`);
  }

  async start(input: StartToolInvocationInput): Promise<ToolInvocationRecord> {
    const now = new Date().toISOString();
    const result = await this.options.pool.query<ToolInvocationRow>(`
      INSERT INTO ${this.table}
        (invocation_id, run_id, session_id, tool_call_id, tool_name, execution_target, tenant_id, status, started_at, updated_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, '${DEFAULT_TENANT_ID}'), 'running', $8, $8, $9::jsonb)
      ON CONFLICT (invocation_id) DO UPDATE SET
        updated_at = EXCLUDED.updated_at,
        tenant_id = CASE WHEN $7 IS NULL THEN ${this.table}.tenant_id ELSE EXCLUDED.tenant_id END,
        metadata = ${this.table}.metadata || EXCLUDED.metadata
      RETURNING *
    `, [
      input.invocationId,
      input.runId,
      input.sessionId,
      input.toolCallId,
      input.toolName,
      input.executionTarget,
      input.tenantId ?? null,
      now,
      JSON.stringify(input.metadata ?? {}),
    ]);
    return rowToRecord(result.rows[0]!);
  }

  async complete(invocationId: string, status: Exclude<ToolInvocationStatus, 'running'>, error?: string): Promise<ToolInvocationRecord | null> {
    const now = new Date().toISOString();
    const result = await this.options.pool.query<ToolInvocationRow>(`
      UPDATE ${this.table}
      SET status = $2, updated_at = $3, completed_at = $3, error = $4
      WHERE invocation_id = $1 AND status = 'running'
      RETURNING *
    `, [invocationId, status, now, error ?? null]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async requestCancel(invocationId: string, reason?: string, metadataPatch: Record<string, unknown> = {}): Promise<ToolInvocationRecord | null> {
    const now = new Date().toISOString();
    const result = await this.options.pool.query<ToolInvocationRow>(`
      UPDATE ${this.table}
      SET cancel_requested_at = COALESCE(cancel_requested_at, $2),
          cancel_reason = COALESCE(cancel_reason, $3),
          updated_at = $2,
          metadata = metadata || $4::jsonb
      WHERE invocation_id = $1 AND status = 'running'
      RETURNING *
    `, [invocationId, now, reason ?? null, JSON.stringify(metadataPatch)]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async markCancelDeliveryAttempt(invocationId: string, metadataPatch: Record<string, unknown> = {}): Promise<ToolInvocationRecord | null> {
    const now = new Date().toISOString();
    const result = await this.options.pool.query<ToolInvocationRow>(`
      UPDATE ${this.table}
      SET updated_at = $2,
          metadata = metadata || $3::jsonb
      WHERE invocation_id = $1
      RETURNING *
    `, [invocationId, now, JSON.stringify(metadataPatch)]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async markCancelDelivered(invocationId: string, metadataPatch: Record<string, unknown> = {}): Promise<ToolInvocationRecord | null> {
    const now = new Date().toISOString();
    const result = await this.options.pool.query<ToolInvocationRow>(`
      UPDATE ${this.table}
      SET cancel_delivered_at = COALESCE(cancel_delivered_at, $2),
          updated_at = $2,
          metadata = metadata || $3::jsonb
      WHERE invocation_id = $1
      RETURNING *
    `, [invocationId, now, JSON.stringify(metadataPatch)]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async get(invocationId: string): Promise<ToolInvocationRecord | null> {
    const result = await this.options.pool.query<ToolInvocationRow>(`SELECT * FROM ${this.table} WHERE invocation_id = $1`, [invocationId]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async listRunning(sessionId?: string): Promise<ToolInvocationRecord[]> {
    const result = sessionId
      ? await this.options.pool.query<ToolInvocationRow>(`SELECT * FROM ${this.table} WHERE status = 'running' AND session_id = $1 ORDER BY started_at ASC`, [sessionId])
      : await this.options.pool.query<ToolInvocationRow>(`SELECT * FROM ${this.table} WHERE status = 'running' ORDER BY started_at ASC`);
    return result.rows.map(rowToRecord);
  }

  async listCancelRequested(sessionId?: string): Promise<ToolInvocationRecord[]> {
    const result = sessionId
      ? await this.options.pool.query<ToolInvocationRow>(`SELECT * FROM ${this.table} WHERE status = 'running' AND cancel_requested_at IS NOT NULL AND cancel_delivered_at IS NULL AND session_id = $1 ORDER BY cancel_requested_at ASC`, [sessionId])
      : await this.options.pool.query<ToolInvocationRow>(`SELECT * FROM ${this.table} WHERE status = 'running' AND cancel_requested_at IS NOT NULL AND cancel_delivered_at IS NULL ORDER BY cancel_requested_at ASC`);
    return result.rows.map(rowToRecord);
  }

  async deleteByTenant(tenantId: string): Promise<number> {
    const result = await this.options.pool.query(`DELETE FROM ${this.table} WHERE tenant_id = $1`, [tenantId]);
    return result.rowCount ?? 0;
  }
}

interface ToolInvocationRow {
  invocation_id: string;
  run_id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  execution_target: ExecutionTargetKind;
  tenant_id: string | null;
  status: ToolInvocationStatus;
  started_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
  cancel_requested_at: Date | string | null;
  cancel_reason: string | null;
  cancel_delivered_at: Date | string | null;
  error: string | null;
  metadata: Record<string, unknown> | string;
}

function rowToRecord(row: ToolInvocationRow): ToolInvocationRecord {
  return {
    invocationId: row.invocation_id,
    runId: row.run_id,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    executionTarget: row.execution_target,
    tenantId: row.tenant_id ?? undefined,
    status: row.status,
    startedAt: toIso(row.started_at),
    updatedAt: toIso(row.updated_at),
    ...(row.completed_at ? { completedAt: toIso(row.completed_at) } : {}),
    ...(row.cancel_requested_at ? { cancelRequestedAt: toIso(row.cancel_requested_at) } : {}),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
    ...(row.cancel_delivered_at ? { cancelDeliveredAt: toIso(row.cancel_delivered_at) } : {}),
    ...(row.error ? { error: row.error } : {}),
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) as Record<string, unknown> : row.metadata,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`非法 PG tablePrefix: ${value}`);
  return value;
}
