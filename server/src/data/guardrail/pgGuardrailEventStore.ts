/**
 * 门禁事件（guardrail_events）PG 存储
 *
 * 专职 Agent 话题门禁的拒绝/打标记录。写侧由 WebChannel fire-and-forget 落库
 * （PG 不可用时降级 log 不阻塞聊天链路）；读侧供组织对话质检台（阶段 2
 * /api/admin/qa/guardrail-events）分页查询——拒绝记录即需求雷达。
 *
 * 仿 pgBillingStore/PgRunStore 模式：CREATE TABLE IF NOT EXISTS + tablePrefix +
 * advisory lock 串行化并发 init。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export type GuardrailEventVerdict = 'off_topic' | 'pass_flagged';

export interface GuardrailEventInsert {
  tenantId: string;
  orgAgentId: string;
  userId?: string;
  username?: string;
  sessionId?: string;
  clientMsgId?: string;
  verdict: GuardrailEventVerdict;
  messageText: string;
  model?: string;
  latencyMs?: number;
}

export interface GuardrailEventRecord extends GuardrailEventInsert {
  id: string;
  createdAt: string;
}

export interface GuardrailEventListFilter {
  tenantId: string;
  orgAgentId?: string;
  userId?: string;
  verdict?: GuardrailEventVerdict;
  /** ISO 8601（含） */
  from?: string;
  /** ISO 8601（含） */
  to?: string;
  offset?: number;
  limit?: number;
}

export interface GuardrailEventStore {
  /** 落库一条门禁事件，返回生成的 event id（员工申诉按 id 关联）。 */
  insert(event: GuardrailEventInsert): Promise<string>;
  list(filter: GuardrailEventListFilter): Promise<{ events: GuardrailEventRecord[]; total: number }>;
}

export interface PgGuardrailEventStoreOptions {
  pool: PgPool;
  tablePrefix?: string;
}

export class PgGuardrailEventStore implements GuardrailEventStore {
  readonly pool: PgPool;
  readonly eventsTable: string;

  constructor(options: PgGuardrailEventStoreOptions) {
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.pool = options.pool;
    this.eventsTable = `${prefix}_guardrail_events`;
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [`${this.eventsTable}:init`]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.eventsTable} (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          org_agent_id TEXT NOT NULL,
          user_id TEXT,
          username TEXT,
          session_id TEXT,
          client_msg_id TEXT,
          verdict TEXT NOT NULL,
          message_text TEXT NOT NULL,
          model TEXT,
          latency_ms INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.eventsTable}_tenant_idx ON ${this.eventsTable} (tenant_id, created_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.eventsTable}_org_agent_idx ON ${this.eventsTable} (org_agent_id, created_at DESC)`);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`${this.eventsTable}:init`]).catch(() => {});
      client.release();
    }
  }

  async insert(event: GuardrailEventInsert): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO ${this.eventsTable}
        (id, tenant_id, org_agent_id, user_id, username, session_id, client_msg_id, verdict, message_text, model, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        event.tenantId,
        event.orgAgentId,
        event.userId ?? null,
        event.username ?? null,
        event.sessionId ?? null,
        event.clientMsgId ?? null,
        event.verdict,
        event.messageText,
        event.model ?? null,
        event.latencyMs ?? null,
      ],
    );
    return id;
  }

  async list(filter: GuardrailEventListFilter): Promise<{ events: GuardrailEventRecord[]; total: number }> {
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [filter.tenantId];
    if (filter.orgAgentId) {
      params.push(filter.orgAgentId);
      conditions.push(`org_agent_id = $${params.length}`);
    }
    if (filter.userId) {
      params.push(filter.userId);
      conditions.push(`user_id = $${params.length}`);
    }
    if (filter.verdict) {
      params.push(filter.verdict);
      conditions.push(`verdict = $${params.length}`);
    }
    if (filter.from) {
      params.push(filter.from);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (filter.to) {
      params.push(filter.to);
      conditions.push(`created_at <= $${params.length}`);
    }
    const where = conditions.join(' AND ');

    const totalResult = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM ${this.eventsTable} WHERE ${where}`,
      params,
    );
    const total = Number(totalResult.rows[0]?.total ?? 0);

    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    params.push(limit, offset);
    const rowsResult = await this.pool.query(
      `SELECT id, tenant_id, org_agent_id, user_id, username, session_id, client_msg_id,
              verdict, message_text, model, latency_ms, created_at
         FROM ${this.eventsTable}
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const events = rowsResult.rows.map((row): GuardrailEventRecord => ({
      id: row.id,
      tenantId: row.tenant_id,
      orgAgentId: row.org_agent_id,
      ...(row.user_id ? { userId: row.user_id } : {}),
      ...(row.username ? { username: row.username } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.client_msg_id ? { clientMsgId: row.client_msg_id } : {}),
      verdict: row.verdict,
      messageText: row.message_text,
      ...(row.model ? { model: row.model } : {}),
      ...(row.latency_ms !== null && row.latency_ms !== undefined ? { latencyMs: Number(row.latency_ms) } : {}),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }));
    return { events, total };
  }
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`非法 PG tablePrefix: ${value}`);
  return value;
}
