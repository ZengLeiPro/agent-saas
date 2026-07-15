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

export interface AdminToolInvocationQuery {
  tenantId?: string;
  userId?: string;
  toolName?: string;
  skillName?: string;
  status?: ToolInvocationStatus;
  reasonContains?: string;
  hours?: number;
  limit?: number;
  offset?: number;
}

export interface AdminToolInvocationEntry {
  invocationId: string;
  runId: string;
  sessionId: string;
  tenantId: string;
  userId: string | null;
  username: string | null;
  toolName: string;
  skillName: string | null;
  executionTarget: ExecutionTargetKind;
  status: ToolInvocationStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

export interface AdminToolInvocationResult {
  items: AdminToolInvocationEntry[];
  summary: {
    total: number;
    failed: number;
    affectedTenants: number;
    affectedUsers: number;
    skillCalls: number;
    skillCallsTracked: number;
  };
  byTool: Array<{
    toolName: string;
    count: number;
    failed: number;
    avgDurationMs: number | null;
    lastCalledAt: string;
  }>;
  bySkill: Array<{
    skillName: string;
    count: number;
    failed: number;
    affectedTenants: number;
    affectedUsers: number;
    lastCalledAt: string;
  }>;
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
  readonly toolInvocationsTable: string;
  readonly sessionsTable: string;

  constructor(private readonly options: PgToolInvocationStoreOptions) {
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.toolInvocationsTable = `${prefix}_tool_invocations`;
    this.sessionsTable = `${prefix}_sessions`;
  }

  async init(): Promise<void> {
    await this.options.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.toolInvocationsTable} (
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
    await this.options.pool.query(`ALTER TABLE ${this.toolInvocationsTable} ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ`);
    await this.options.pool.query(`ALTER TABLE ${this.toolInvocationsTable} ADD COLUMN IF NOT EXISTS cancel_reason TEXT`);
    await this.options.pool.query(`ALTER TABLE ${this.toolInvocationsTable} ADD COLUMN IF NOT EXISTS cancel_delivered_at TIMESTAMPTZ`);
    // PR 3：多组织改造 — 加 tenant_id 列。旧 invocation 回填 LEGACY_TENANT_ID；
    // 新 invocation 由调用方传入或走平台根 fallback。
    await this.options.pool.query(`ALTER TABLE ${this.toolInvocationsTable} ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT_ID}'`);
    await this.options.pool.query(`CREATE INDEX IF NOT EXISTS ${this.toolInvocationsTable}_session_idx ON ${this.toolInvocationsTable} (session_id)`);
    await this.options.pool.query(`CREATE INDEX IF NOT EXISTS ${this.toolInvocationsTable}_run_idx ON ${this.toolInvocationsTable} (run_id)`);
    await this.options.pool.query(`CREATE INDEX IF NOT EXISTS ${this.toolInvocationsTable}_status_idx ON ${this.toolInvocationsTable} (status)`);
    await this.options.pool.query(`CREATE INDEX IF NOT EXISTS ${this.toolInvocationsTable}_tenant_idx ON ${this.toolInvocationsTable} (tenant_id, started_at DESC)`);
    await this.options.pool.query(`CREATE INDEX IF NOT EXISTS ${this.toolInvocationsTable}_tool_name_idx ON ${this.toolInvocationsTable} (tool_name, started_at DESC)`);
  }

  async start(input: StartToolInvocationInput): Promise<ToolInvocationRecord> {
    const now = new Date().toISOString();
    const result = await this.options.pool.query<ToolInvocationRow>(`
      INSERT INTO ${this.toolInvocationsTable}
        (invocation_id, run_id, session_id, tool_call_id, tool_name, execution_target, tenant_id, status, started_at, updated_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, '${DEFAULT_TENANT_ID}'), 'running', $8, $8, $9::jsonb)
      ON CONFLICT (invocation_id) DO UPDATE SET
        updated_at = EXCLUDED.updated_at,
        tenant_id = CASE WHEN $7 IS NULL THEN ${this.toolInvocationsTable}.tenant_id ELSE EXCLUDED.tenant_id END,
        metadata = ${this.toolInvocationsTable}.metadata || EXCLUDED.metadata
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
      UPDATE ${this.toolInvocationsTable}
      SET status = $2, updated_at = $3, completed_at = $3, error = $4
      WHERE invocation_id = $1 AND status = 'running'
      RETURNING *
    `, [invocationId, status, now, error ?? null]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async requestCancel(invocationId: string, reason?: string, metadataPatch: Record<string, unknown> = {}): Promise<ToolInvocationRecord | null> {
    const now = new Date().toISOString();
    const result = await this.options.pool.query<ToolInvocationRow>(`
      UPDATE ${this.toolInvocationsTable}
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
      UPDATE ${this.toolInvocationsTable}
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
      UPDATE ${this.toolInvocationsTable}
      SET cancel_delivered_at = COALESCE(cancel_delivered_at, $2),
          updated_at = $2,
          metadata = metadata || $3::jsonb
      WHERE invocation_id = $1
      RETURNING *
    `, [invocationId, now, JSON.stringify(metadataPatch)]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async get(invocationId: string): Promise<ToolInvocationRecord | null> {
    const result = await this.options.pool.query<ToolInvocationRow>(`SELECT * FROM ${this.toolInvocationsTable} WHERE invocation_id = $1`, [invocationId]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async listRunning(sessionId?: string): Promise<ToolInvocationRecord[]> {
    const result = sessionId
      ? await this.options.pool.query<ToolInvocationRow>(`SELECT * FROM ${this.toolInvocationsTable} WHERE status = 'running' AND session_id = $1 ORDER BY started_at ASC`, [sessionId])
      : await this.options.pool.query<ToolInvocationRow>(`SELECT * FROM ${this.toolInvocationsTable} WHERE status = 'running' ORDER BY started_at ASC`);
    return result.rows.map(rowToRecord);
  }

  async listCancelRequested(sessionId?: string): Promise<ToolInvocationRecord[]> {
    const result = sessionId
      ? await this.options.pool.query<ToolInvocationRow>(`SELECT * FROM ${this.toolInvocationsTable} WHERE status = 'running' AND cancel_requested_at IS NOT NULL AND cancel_delivered_at IS NULL AND session_id = $1 ORDER BY cancel_requested_at ASC`, [sessionId])
      : await this.options.pool.query<ToolInvocationRow>(`SELECT * FROM ${this.toolInvocationsTable} WHERE status = 'running' AND cancel_requested_at IS NOT NULL AND cancel_delivered_at IS NULL ORDER BY cancel_requested_at ASC`);
    return result.rows.map(rowToRecord);
  }

  async deleteByTenant(tenantId: string): Promise<number> {
    const result = await this.options.pool.query(`DELETE FROM ${this.toolInvocationsTable} WHERE tenant_id = $1`, [tenantId]);
    return result.rowCount ?? 0;
  }

  async listForAdmin(query: AdminToolInvocationQuery = {}): Promise<AdminToolInvocationResult> {
    const params: unknown[] = [];
    const clauses: string[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      clauses.push(clause.replace('?', `$${params.length}`));
    };
    add('t.started_at >= now() - make_interval(hours => ?::int)', query.hours ?? 168);
    if (query.tenantId) add('t.tenant_id = ?', query.tenantId);
    if (query.userId) add('s.user_id = ?', query.userId);
    if (query.toolName) add('lower(t.tool_name) = lower(?)', query.toolName);
    if (query.skillName) add("lower(NULLIF(t.metadata->>'skillName', '')) = lower(?)", query.skillName);
    if (query.status) add('t.status = ?', query.status);
    if (query.reasonContains) add("COALESCE(t.error, '') ILIKE '%' || ? || '%'", query.reasonContains);
    const where = clauses.join(' AND ');
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const offset = Math.max(query.offset ?? 0, 0);
    const pageParams = [...params, limit, offset];

    const [itemsResult, summaryResult, byToolResult, bySkillResult] = await Promise.all([
      this.options.pool.query<AdminToolInvocationRow>(`
        SELECT t.invocation_id, t.run_id, t.session_id, t.tenant_id,
               s.user_id, s.username, t.tool_name,
               NULLIF(t.metadata->>'skillName', '') AS skill_name,
               t.execution_target, t.status, t.started_at, t.completed_at,
               CASE WHEN t.completed_at IS NULL THEN NULL
                    ELSE GREATEST(0, EXTRACT(EPOCH FROM (t.completed_at - t.started_at)) * 1000)
               END AS duration_ms,
               t.error
        FROM ${this.toolInvocationsTable} t
        LEFT JOIN ${this.sessionsTable} s ON s.session_id = t.session_id
        WHERE ${where}
        ORDER BY t.started_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `, pageParams),
      this.options.pool.query<AdminToolInvocationSummaryRow>(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE t.status IN ('failed', 'cancelled'))::int AS failed,
               count(DISTINCT t.tenant_id)::int AS affected_tenants,
               count(DISTINCT s.user_id) FILTER (WHERE s.user_id IS NOT NULL)::int AS affected_users,
               count(*) FILTER (WHERE lower(t.tool_name) = 'skill')::int AS skill_calls,
               count(*) FILTER (
                 WHERE lower(t.tool_name) = 'skill' AND NULLIF(t.metadata->>'skillName', '') IS NOT NULL
               )::int AS skill_calls_tracked
        FROM ${this.toolInvocationsTable} t
        LEFT JOIN ${this.sessionsTable} s ON s.session_id = t.session_id
        WHERE ${where}
      `, params),
      this.options.pool.query<AdminToolInvocationByToolRow>(`
        SELECT t.tool_name,
               count(*)::int AS count,
               count(*) FILTER (WHERE t.status IN ('failed', 'cancelled'))::int AS failed,
               avg(EXTRACT(EPOCH FROM (t.completed_at - t.started_at)) * 1000)
                 FILTER (WHERE t.completed_at IS NOT NULL) AS avg_duration_ms,
               max(t.started_at) AS last_called_at
        FROM ${this.toolInvocationsTable} t
        LEFT JOIN ${this.sessionsTable} s ON s.session_id = t.session_id
        WHERE ${where}
        GROUP BY t.tool_name
        ORDER BY count DESC, t.tool_name ASC
        LIMIT 100
      `, params),
      this.options.pool.query<AdminToolInvocationBySkillRow>(`
        SELECT NULLIF(t.metadata->>'skillName', '') AS skill_name,
               count(*)::int AS count,
               count(*) FILTER (WHERE t.status IN ('failed', 'cancelled'))::int AS failed,
               count(DISTINCT t.tenant_id)::int AS affected_tenants,
               count(DISTINCT s.user_id) FILTER (WHERE s.user_id IS NOT NULL)::int AS affected_users,
               max(t.started_at) AS last_called_at
        FROM ${this.toolInvocationsTable} t
        LEFT JOIN ${this.sessionsTable} s ON s.session_id = t.session_id
        WHERE ${where} AND NULLIF(t.metadata->>'skillName', '') IS NOT NULL
        GROUP BY skill_name
        ORDER BY count DESC, skill_name ASC
        LIMIT 100
      `, params),
    ]);
    const summary = summaryResult.rows[0];
    return {
      items: itemsResult.rows.map(rowToAdminEntry),
      summary: {
        total: summary?.total ?? 0,
        failed: summary?.failed ?? 0,
        affectedTenants: summary?.affected_tenants ?? 0,
        affectedUsers: summary?.affected_users ?? 0,
        skillCalls: summary?.skill_calls ?? 0,
        skillCallsTracked: summary?.skill_calls_tracked ?? 0,
      },
      byTool: byToolResult.rows.map((row) => ({
        toolName: row.tool_name,
        count: row.count,
        failed: row.failed,
        avgDurationMs: nullableNumber(row.avg_duration_ms),
        lastCalledAt: toIso(row.last_called_at),
      })),
      bySkill: bySkillResult.rows.map((row) => ({
        skillName: row.skill_name,
        count: row.count,
        failed: row.failed,
        affectedTenants: row.affected_tenants,
        affectedUsers: row.affected_users,
        lastCalledAt: toIso(row.last_called_at),
      })),
    };
  }
}

interface AdminToolInvocationRow {
  invocation_id: string;
  run_id: string;
  session_id: string;
  tenant_id: string;
  user_id: string | null;
  username: string | null;
  tool_name: string;
  skill_name: string | null;
  execution_target: ExecutionTargetKind;
  status: ToolInvocationStatus;
  started_at: Date | string;
  completed_at: Date | string | null;
  duration_ms: string | number | null;
  error: string | null;
}

interface AdminToolInvocationSummaryRow {
  total: number;
  failed: number;
  affected_tenants: number;
  affected_users: number;
  skill_calls: number;
  skill_calls_tracked: number;
}

interface AdminToolInvocationByToolRow {
  tool_name: string;
  count: number;
  failed: number;
  avg_duration_ms: string | number | null;
  last_called_at: Date | string;
}

interface AdminToolInvocationBySkillRow {
  skill_name: string;
  count: number;
  failed: number;
  affected_tenants: number;
  affected_users: number;
  last_called_at: Date | string;
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

function rowToAdminEntry(row: AdminToolInvocationRow): AdminToolInvocationEntry {
  return {
    invocationId: row.invocation_id,
    runId: row.run_id,
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    username: row.username,
    toolName: row.tool_name,
    skillName: row.skill_name,
    executionTarget: row.execution_target,
    status: row.status,
    startedAt: toIso(row.started_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
    durationMs: nullableNumber(row.duration_ms),
    error: row.error,
  };
}

function nullableNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`非法 PG tablePrefix: ${value}`);
  return value;
}
