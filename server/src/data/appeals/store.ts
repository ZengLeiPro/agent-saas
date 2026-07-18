/**
 * 员工申诉（runtime_guardrail_appeals）PG 存储
 *
 * 员工被专职 Agent 门禁拒答后，可就单条 guardrail_event 提交一次申诉。
 * 管理员在 QaConsole 侧看到 pending 列表后处理为 accepted / rejected。
 *
 * 表结构：
 *   id                 TEXT PK（ap-${uuid}）
 *   tenant_id          TEXT NOT NULL
 *   guardrail_event_id TEXT NOT NULL  — FK 语义，未强约束（跨表 fk 遵循现有 runtime_* 惯例）
 *   user_id            TEXT NOT NULL  — 提申诉的员工
 *   user_message       TEXT NOT NULL  — 被拒答的原文（冗余存）
 *   expert_id          TEXT NOT NULL  — 涉及的企业专家（冗余存）
 *   appeal_reason      TEXT           — 员工填的申诉理由，可选
 *   status             TEXT NOT NULL  — pending / accepted / rejected
 *   handled_by         TEXT           — 管理员 userId
 *   handled_at         TIMESTAMPTZ
 *   handle_note        TEXT           — 管理员留言
 *   created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
 *
 * 索引：
 *   (tenant_id, status)                        — QaConsole 按状态过滤
 *   (tenant_id, expert_id, created_at DESC)    — 按专家维度看申诉趋势
 *
 * 幂等：UNIQUE (guardrail_event_id, user_id) 防止同一员工对同一次拒答反复申诉。
 *
 * 仿 PgGuardrailEventStore / PgMessageFeedbackStore 模式：CREATE TABLE IF NOT EXISTS
 * + advisory lock 串行化并发 init（多实例启动竞争无碍）。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type {
  AppealHandleInput,
  GuardrailAppealInsert,
  GuardrailAppealListFilter,
  GuardrailAppealListResult,
  GuardrailAppealRecord,
  GuardrailEventOwnerLookup,
} from './types.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export interface AppealStore {
  /** 创建申诉；违反 UNIQUE (guardrail_event_id, user_id) 时抛业务异常码 'DUPLICATE_APPEAL' */
  create(input: GuardrailAppealInsert): Promise<GuardrailAppealRecord>;
  /** 按 id 取单条（含 tenant 守卫；tenantId 不匹配返回 null 防跨租户探测） */
  getById(id: string, tenantId: string): Promise<GuardrailAppealRecord | null>;
  /** 分页列表；总是要求 tenantId */
  list(filter: GuardrailAppealListFilter): Promise<GuardrailAppealListResult>;
  /** 管理员处理；只允许 pending → accepted / rejected；重复处理返回 null */
  handle(id: string, tenantId: string, input: AppealHandleInput): Promise<GuardrailAppealRecord | null>;
  /**
   * 读侧越权守卫依赖：按 guardrail_event_id 取 owner 与所属租户。
   * 命中不到返回 null；调用方据此拒 404/403。
   */
  getGuardrailEventOwner(guardrailEventId: string): Promise<GuardrailEventOwnerLookup | null>;
}

export interface PgAppealStoreOptions {
  pool: PgPool;
  tablePrefix?: string;
}

export class DuplicateAppealError extends Error {
  readonly code = 'DUPLICATE_APPEAL';
  constructor() { super('已存在针对该拒答的申诉'); }
}

export class PgAppealStore implements AppealStore {
  readonly pool: PgPool;
  readonly appealsTable: string;
  readonly guardrailEventsTable: string;

  constructor(options: PgAppealStoreOptions) {
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.pool = options.pool;
    this.appealsTable = `${prefix}_guardrail_appeals`;
    // 与 PgGuardrailEventStore 保持同 prefix；越权守卫从这张表 SELECT
    this.guardrailEventsTable = `${prefix}_guardrail_events`;
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [`${this.appealsTable}:init`]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.appealsTable} (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          guardrail_event_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          user_message TEXT NOT NULL,
          expert_id TEXT NOT NULL,
          appeal_reason TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          handled_by TEXT,
          handled_at TIMESTAMPTZ,
          handle_note TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (guardrail_event_id, user_id)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.appealsTable}_tenant_status_idx `
        + `ON ${this.appealsTable} (tenant_id, status)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.appealsTable}_tenant_expert_idx `
        + `ON ${this.appealsTable} (tenant_id, expert_id, created_at DESC)`,
      );
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`${this.appealsTable}:init`]).catch(() => {});
      client.release();
    }
  }

  async create(input: GuardrailAppealInsert): Promise<GuardrailAppealRecord> {
    const id = `ap-${randomUUID()}`;
    try {
      const result = await this.pool.query(
        `INSERT INTO ${this.appealsTable}
          (id, tenant_id, guardrail_event_id, user_id, user_message, expert_id, appeal_reason, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         RETURNING id, tenant_id, guardrail_event_id, user_id, user_message, expert_id,
                   appeal_reason, status, handled_by, handled_at, handle_note, created_at`,
        [
          id,
          input.tenantId,
          input.guardrailEventId,
          input.userId,
          input.userMessage,
          input.expertId,
          input.appealReason ?? null,
        ],
      );
      return rowToRecord(result.rows[0]);
    } catch (err) {
      // 23505 unique_violation
      if (isUniqueViolation(err)) throw new DuplicateAppealError();
      throw err;
    }
  }

  async getById(id: string, tenantId: string): Promise<GuardrailAppealRecord | null> {
    const result = await this.pool.query(
      `SELECT id, tenant_id, guardrail_event_id, user_id, user_message, expert_id,
              appeal_reason, status, handled_by, handled_at, handle_note, created_at
         FROM ${this.appealsTable}
        WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (result.rows.length === 0) return null;
    return rowToRecord(result.rows[0]);
  }

  async list(filter: GuardrailAppealListFilter): Promise<GuardrailAppealListResult> {
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [filter.tenantId];
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.expertId) {
      params.push(filter.expertId);
      conditions.push(`expert_id = $${params.length}`);
    }
    if (filter.userId) {
      params.push(filter.userId);
      conditions.push(`user_id = $${params.length}`);
    }
    const where = conditions.join(' AND ');

    const totalResult = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM ${this.appealsTable} WHERE ${where}`,
      params,
    );
    const total = Number(totalResult.rows[0]?.total ?? 0);

    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    params.push(limit, offset);
    const rowsResult = await this.pool.query(
      `SELECT id, tenant_id, guardrail_event_id, user_id, user_message, expert_id,
              appeal_reason, status, handled_by, handled_at, handle_note, created_at
         FROM ${this.appealsTable}
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const items = rowsResult.rows.map(rowToRecord);
    return { items, total };
  }

  async handle(id: string, tenantId: string, input: AppealHandleInput): Promise<GuardrailAppealRecord | null> {
    // 只允许 pending → accepted / rejected；已处理再次调用返回 null（路由据此 409）
    const result = await this.pool.query(
      `UPDATE ${this.appealsTable}
          SET status = $3,
              handled_by = $4,
              handled_at = now(),
              handle_note = $5
        WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
        RETURNING id, tenant_id, guardrail_event_id, user_id, user_message, expert_id,
                  appeal_reason, status, handled_by, handled_at, handle_note, created_at`,
      [id, tenantId, input.status, input.handledBy, input.handleNote ?? null],
    );
    if (result.rows.length === 0) return null;
    return rowToRecord(result.rows[0]);
  }

  async getGuardrailEventOwner(guardrailEventId: string): Promise<GuardrailEventOwnerLookup | null> {
    // 只读跨表 SELECT — 不修改 guardrail_events 表结构，仅按 id 取归属做越权校验。
    // 若 guardrail_events 表尚未初始化（file backend），let PG 抛错交由上层降级处理。
    const result = await this.pool.query(
      `SELECT tenant_id, user_id, org_agent_id, message_text
         FROM ${this.guardrailEventsTable}
        WHERE id = $1`,
      [guardrailEventId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      tenantId: String(row.tenant_id),
      ...(row.user_id ? { userId: String(row.user_id) } : {}),
      orgAgentId: String(row.org_agent_id),
      messageText: String(row.message_text),
    };
  }
}

function rowToRecord(row: Record<string, unknown>): GuardrailAppealRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    guardrailEventId: String(row.guardrail_event_id),
    userId: String(row.user_id),
    userMessage: String(row.user_message),
    expertId: String(row.expert_id),
    ...(row.appeal_reason ? { appealReason: String(row.appeal_reason) } : {}),
    status: String(row.status) as GuardrailAppealRecord['status'],
    ...(row.handled_by ? { handledBy: String(row.handled_by) } : {}),
    ...(row.handled_at
      ? { handledAt: row.handled_at instanceof Date ? row.handled_at.toISOString() : String(row.handled_at) }
      : {}),
    ...(row.handle_note ? { handleNote: String(row.handle_note) } : {}),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === '23505';
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`非法 PG tablePrefix: ${value}`);
  return value;
}
