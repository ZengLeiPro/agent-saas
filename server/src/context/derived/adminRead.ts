import type { ContextPgPool } from '../store/migration.js';
import { contextTableNames, contextTablePrefix } from '../store/migration.js';
import { tableNames } from '../phase23/migration.js';

const CONSUMER_STALE_MS = 5 * 60_000;

export interface ContextConsumerAdminStatus {
  id: string;
  name: string;
  kind: string;
  status: 'current' | 'lagging' | 'blocked' | 'offline';
  watermarkAt: string | null;
  lagSeconds: null;
  detail: string;
}

/** Honest admin read model: sequence lag is reported as a count, never fabricated as seconds. */
export class DerivedContextAdminReadStore {
  private readonly derived;
  private readonly base;

  constructor(
    private readonly pool: ContextPgPool,
    tablePrefix?: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    const prefix = contextTablePrefix(tablePrefix);
    this.derived = tableNames(prefix);
    this.base = contextTableNames(prefix);
  }

  async listConsumers(tenantId: string): Promise<ContextConsumerAdminStatus[]> {
    const result = await this.pool.query(`
      SELECT consumer.consumer_id,consumer.cursor_seq,consumer.status,consumer.updated_at,
             consumer.last_heartbeat_at,consumer.last_error_code,
             COALESCE(MAX(outbox.seq),0) AS max_seq
      FROM ${this.derived.consumers} consumer
      LEFT JOIN ${this.base.outbox} outbox ON outbox.tenant_id=consumer.tenant_id
      WHERE consumer.tenant_id=$1
      GROUP BY consumer.tenant_id,consumer.consumer_id,consumer.cursor_seq,consumer.status,
               consumer.updated_at,consumer.last_heartbeat_at,consumer.last_error_code
      ORDER BY consumer.consumer_id
    `, [tenantId]);
    return result.rows.map(row => {
      const cursor = BigInt(String(row.cursor_seq));
      const max = BigInt(String(row.max_seq));
      const lag = max > cursor ? max - cursor : 0n;
      const rawStatus = String(row.status);
      const heartbeatAt = row.last_heartbeat_at ? new Date(row.last_heartbeat_at) : null;
      const stale = !heartbeatAt || this.now().getTime() - heartbeatAt.getTime() > CONSUMER_STALE_MS;
      const status = rawStatus === 'disabled' || stale
        ? 'offline' as const
        : rawStatus === 'retry_wait'
          ? 'blocked' as const
          : lag > 0n
            ? 'lagging' as const
            : 'current' as const;
      const detail = rawStatus === 'disabled'
        ? '派生消费者已禁用'
        : stale
          ? '派生消费者超过 5 分钟无 heartbeat'
          : rawStatus === 'retry_wait'
            ? `派生消费者等待重试${row.last_error_code ? `：${String(row.last_error_code)}` : ''}`
            : lag > 0n ? `待处理 ${lag.toString()} 个 Context revision` : 'Context revision 已追平';
      return {
        id: String(row.consumer_id),
        name: String(row.consumer_id),
        kind: 'deterministic-projector',
        status,
        watermarkAt: heartbeatAt?.toISOString() ?? null,
        lagSeconds: null,
        detail,
      };
    });
  }
}
