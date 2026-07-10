/**
 * 消息反馈（message_feedback）PG 存储（2026-07 唯恩批次）
 *
 * 员工对专职 Agent 回答点「踩」+ 可选评论。消息 id 跨刷新不稳定（流式=客户端
 * 随机 id，刷新后=line-N），因此以 **content_hash（sha256(消息全文)）为幂等键**：
 * UNIQUE (tenant_id, session_id, user_id, content_hash)，重复提交 ON CONFLICT
 * DO NOTHING 返回 duplicated。
 *
 * 接口化（MessageFeedbackStore）供路由测试注入内存实现；PG 实现仿
 * pgGuardrailEventStore 模式（tablePrefix + advisory lock init）。
 * file backend 时 runtime 不装配（undefined）→ 路由 503。
 */

import pg from 'pg';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export interface MessageFeedbackInsert {
  tenantId: string;
  sessionId: string;
  messageId: string;
  orgAgentId?: string;
  userId: string;
  username?: string;
  comment?: string;
  /** 消息全文前 500 字（server 截取，质检台列表展示用） */
  messageExcerpt: string;
  /** sha256(消息全文) hex（server 计算，幂等键） */
  contentHash: string;
}

export interface MessageFeedbackRecord extends MessageFeedbackInsert {
  id: string;
  verdict: 'down';
  createdAt: string;
}

export interface MessageFeedbackListFilter {
  tenantId: string;
  orgAgentId?: string;
  userId?: string;
  /** ISO 8601（含） */
  from?: string;
  /** ISO 8601（含） */
  to?: string;
  offset?: number;
  limit?: number;
}

/** 本人已反馈状态恢复用的裁剪视图 */
export interface MessageFeedbackOwnItem {
  contentHash: string;
  comment?: string;
  createdAt: string;
}

export interface MessageFeedbackStore {
  /** 幂等插入。重复（同 tenant+session+user+contentHash）→ { duplicated: true } */
  insert(item: MessageFeedbackInsert): Promise<{ duplicated: boolean }>;
  listByTenant(filter: MessageFeedbackListFilter): Promise<{ items: MessageFeedbackRecord[]; total: number }>;
  /** 本人在某会话的反馈（进会话时恢复"已反馈"态） */
  listBySessionUser(sessionId: string, userId: string): Promise<MessageFeedbackOwnItem[]>;
}

export interface PgMessageFeedbackStoreOptions {
  pool: PgPool;
  tablePrefix?: string;
}

export class PgMessageFeedbackStore implements MessageFeedbackStore {
  readonly pool: PgPool;
  readonly feedbackTable: string;

  constructor(options: PgMessageFeedbackStoreOptions) {
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.pool = options.pool;
    this.feedbackTable = `${prefix}_message_feedback`;
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [`${this.feedbackTable}:init`]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.feedbackTable} (
          id BIGSERIAL PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          org_agent_id TEXT,
          user_id TEXT NOT NULL,
          username TEXT,
          verdict TEXT NOT NULL DEFAULT 'down',
          comment TEXT,
          message_excerpt TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (tenant_id, session_id, user_id, content_hash)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.feedbackTable}_tenant_idx ON ${this.feedbackTable} (tenant_id, created_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.feedbackTable}_org_agent_idx ON ${this.feedbackTable} (tenant_id, org_agent_id, created_at DESC)`);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`${this.feedbackTable}:init`]).catch(() => {});
      client.release();
    }
  }

  async insert(item: MessageFeedbackInsert): Promise<{ duplicated: boolean }> {
    const result = await this.pool.query(
      `INSERT INTO ${this.feedbackTable}
        (tenant_id, session_id, message_id, org_agent_id, user_id, username, comment, message_excerpt, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, session_id, user_id, content_hash) DO NOTHING`,
      [
        item.tenantId,
        item.sessionId,
        item.messageId,
        item.orgAgentId ?? null,
        item.userId,
        item.username ?? null,
        item.comment ?? null,
        item.messageExcerpt,
        item.contentHash,
      ],
    );
    return { duplicated: (result.rowCount ?? 0) === 0 };
  }

  async listByTenant(filter: MessageFeedbackListFilter): Promise<{ items: MessageFeedbackRecord[]; total: number }> {
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
      `SELECT COUNT(*)::text AS total FROM ${this.feedbackTable} WHERE ${where}`,
      params,
    );
    const total = Number(totalResult.rows[0]?.total ?? 0);

    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    params.push(limit, offset);
    const rowsResult = await this.pool.query(
      `SELECT id, tenant_id, session_id, message_id, org_agent_id, user_id, username,
              verdict, comment, message_excerpt, content_hash, created_at
         FROM ${this.feedbackTable}
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const items = rowsResult.rows.map((row): MessageFeedbackRecord => rowToRecord(row));
    return { items, total };
  }

  async listBySessionUser(sessionId: string, userId: string): Promise<MessageFeedbackOwnItem[]> {
    const result = await this.pool.query(
      `SELECT content_hash, comment, created_at
         FROM ${this.feedbackTable}
        WHERE session_id = $1 AND user_id = $2
        ORDER BY created_at ASC`,
      [sessionId, userId],
    );
    return result.rows.map((row) => ({
      contentHash: row.content_hash,
      ...(row.comment ? { comment: row.comment } : {}),
      createdAt: toIso(row.created_at),
    }));
  }
}

function rowToRecord(row: Record<string, unknown>): MessageFeedbackRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    sessionId: String(row.session_id),
    messageId: String(row.message_id),
    ...(row.org_agent_id ? { orgAgentId: String(row.org_agent_id) } : {}),
    userId: String(row.user_id),
    ...(row.username ? { username: String(row.username) } : {}),
    verdict: 'down',
    ...(row.comment ? { comment: String(row.comment) } : {}),
    messageExcerpt: String(row.message_excerpt),
    contentHash: String(row.content_hash),
    createdAt: toIso(row.created_at),
  };
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`非法 PG tablePrefix: ${value}`);
  return value;
}
