/**
 * WP2a 平台 → 定制项目事件 outbox（规范 §3.7、§8.4）。
 *
 * 入队 / 取待发 / 标记结果三段式；同一安装实例的同类型同 `stateVersion` 事件唯一，
 * 重复入队即幂等。投递由 Phase B 的 dispatcher 消费本表。
 */
import { randomUUID } from 'node:crypto';

import {
  PgGovernanceMigrationRunner,
  governanceTablePrefix,
  type GovernancePgPool,
} from '../../data/governance-schema/index.js';

export const KY_APP_EVENT_TYPES = [
  'installation.enabled',
  'installation.disabled',
  'installation.deleted',
  'jwks.rotated',
  'jwks.revoke',
  'jwks.probe',
] as const;
export type KyAppEventType = (typeof KY_APP_EVENT_TYPES)[number];

export const KY_APP_EVENT_STATUSES = ['pending', 'delivered', 'failed', 'abandoned'] as const;
export type KyAppEventStatus = (typeof KY_APP_EVENT_STATUSES)[number];

export interface KyAppOutboundEvent {
  eventId: string;
  installationId: string;
  stateVersion: number;
  type: KyAppEventType;
  payload: Record<string, unknown>;
  status: KyAppEventStatus;
  attempts: number;
  occurredAt: string;
  nextAttemptAt: string;
  giveUpAt: string;
  deliveredAt: string | null;
  verifiedKid: string | null;
  lastError: string | null;
}

export interface EnqueueKyAppEventInput {
  installationId: string;
  stateVersion: number;
  type: KyAppEventType;
  payload?: Record<string, unknown>;
  /** 重试窗口（毫秒），默认由调用方按 kyApp 配置传入。 */
  retryWindowMs: number;
  eventId?: string;
  now?: Date;
}

type Row = Record<string, unknown>;

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function rowToEvent(row: Row): KyAppOutboundEvent {
  return {
    eventId: String(row.event_id),
    installationId: String(row.installation_id),
    stateVersion: Number(row.state_version),
    type: String(row.type) as KyAppEventType,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: String(row.status) as KyAppEventStatus,
    attempts: Number(row.attempts),
    occurredAt: iso(row.occurred_at),
    nextAttemptAt: iso(row.next_attempt_at),
    giveUpAt: iso(row.give_up_at),
    deliveredAt: isoOrNull(row.delivered_at),
    verifiedKid: row.verified_kid === null ? null : String(row.verified_kid),
    lastError: row.last_error === null ? null : String(row.last_error),
  };
}

/** 指数退避：1s、2s、4s…上限 15 分钟（规范 §3.7 平台重试 24 小时）。 */
export function backoffDelayMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 0), 10);
  return Math.min(1000 * 2 ** exponent, 15 * 60 * 1000);
}

export interface PgKyAppOutboundEventStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

export class PgKyAppOutboundEventStore {
  readonly table: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: PgKyAppOutboundEventStoreOptions) {
    this.tablePrefix = options.tablePrefix;
    this.table = `${governanceTablePrefix(options.tablePrefix)}_ky_app_outbound_events`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  /** 入队；同 (安装实例, 类型, stateVersion) 重复入队直接返回既有事件。 */
  async enqueue(input: EnqueueKyAppEventInput): Promise<KyAppOutboundEvent> {
    const now = input.now ?? new Date();
    const giveUpAt = new Date(now.getTime() + input.retryWindowMs);
    const result = await this.options.pool.query(
      `INSERT INTO ${this.table}
         (event_id,installation_id,state_version,type,payload,status,attempts,
          occurred_at,next_attempt_at,give_up_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,'pending',0,$6,$6,$7)
       ON CONFLICT (installation_id,type,state_version) DO NOTHING
       RETURNING *`,
      [
        input.eventId ?? randomUUID(),
        input.installationId,
        input.stateVersion,
        input.type,
        JSON.stringify(input.payload ?? {}),
        now,
        giveUpAt,
      ],
    );
    if (result.rows[0]) return rowToEvent(result.rows[0] as Row);
    const existing = await this.options.pool.query(
      `SELECT * FROM ${this.table}
       WHERE installation_id=$1 AND type=$2 AND state_version=$3`,
      [input.installationId, input.type, input.stateVersion],
    );
    return rowToEvent(existing.rows[0] as Row);
  }

  /** 取到期待发事件；按 stateVersion 升序，保证同一安装实例的事件按序投递。 */
  async listDue(now: Date, limit = 50): Promise<KyAppOutboundEvent[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.table}
       WHERE status='pending' AND next_attempt_at <= $1
       ORDER BY installation_id, state_version, occurred_at
       LIMIT $2`,
      [now, limit],
    );
    return result.rows.map((row) => rowToEvent(row as Row));
  }

  /** 按安装实例回放缺失事件（对方回 409 `state_gap` 时用）。 */
  async listSince(installationId: string, stateVersion: number): Promise<KyAppOutboundEvent[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.table}
       WHERE installation_id=$1 AND state_version >= $2
       ORDER BY state_version, occurred_at`,
      [installationId, stateVersion],
    );
    return result.rows.map((row) => rowToEvent(row as Row));
  }

  async markDelivered(eventId: string, verifiedKid?: string): Promise<KyAppOutboundEvent | null> {
    const result = await this.options.pool.query(
      `UPDATE ${this.table}
       SET status='delivered', delivered_at=NOW(), attempts=attempts+1,
           verified_kid=$2, last_error=NULL
       WHERE event_id=$1 AND status='pending' RETURNING *`,
      [eventId, verifiedKid ?? null],
    );
    return result.rows[0] ? rowToEvent(result.rows[0] as Row) : null;
  }

  /**
   * 标记一次失败：递增 attempts、按指数退避排下一次；
   * 超出 24 小时重试窗口即 `abandoned`（规范 §3.7）。
   */
  async markFailed(input: {
    eventId: string;
    error: string;
    now?: Date;
  }): Promise<KyAppOutboundEvent | null> {
    const now = input.now ?? new Date();
    const current = await this.options.pool.query(
      `SELECT attempts, give_up_at FROM ${this.table} WHERE event_id=$1 AND status='pending'`,
      [input.eventId],
    );
    const row = current.rows[0] as Row | undefined;
    if (!row) return null;
    const attempts = Number(row.attempts) + 1;
    const giveUpAt =
      row.give_up_at instanceof Date ? row.give_up_at : new Date(String(row.give_up_at));
    const nextAttemptAt = new Date(now.getTime() + backoffDelayMs(attempts));
    const exhausted = nextAttemptAt.getTime() > giveUpAt.getTime();
    const result = await this.options.pool.query(
      `UPDATE ${this.table}
       SET status=$4, attempts=$2, next_attempt_at=$3, last_error=$5
       WHERE event_id=$1 AND status='pending' RETURNING *`,
      [
        input.eventId,
        attempts,
        nextAttemptAt,
        exhausted ? 'abandoned' : 'pending',
        input.error.slice(0, 500),
      ],
    );
    return result.rows[0] ? rowToEvent(result.rows[0] as Row) : null;
  }
}
