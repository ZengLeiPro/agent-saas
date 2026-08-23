import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;
const MAX_SUBSCRIPTIONS_PER_USER = 20;

export interface WebPushOwner {
  tenantId: string;
  userId: string;
}

export interface WebPushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  deviceName: string;
}

export interface WebPushSubscriptionRecord extends WebPushOwner {
  id: string;
  endpoint: string;
  endpointHash: string;
  p256dh: string;
  auth: string;
  deviceName: string;
  createdAt: string;
  updatedAt: string;
}

interface SubscriptionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  endpoint: string;
  endpoint_hash: string;
  p256dh: string;
  auth: string;
  device_name: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface PgWebPushStoreOptions {
  pool: PgPool;
  tablePrefix?: string;
}

export interface WebPushDeliveryClaim {
  subscription: WebPushSubscriptionRecord;
  finish(status: 'sent' | 'failed', error?: string): Promise<void>;
  invalidate(): Promise<void>;
}

export interface WebPushDeliveryDeferred {
  deferred: true;
}

/**
 * Web Push 订阅与投递幂等记录。
 *
 * endpoint 是浏览器推送服务签发的设备级能力 URL，全局唯一。用户在共享浏览器显式
 * 开启通知时会原子重绑到当前身份，避免退出登录后继续向旧账号串发。
 */
export class PgWebPushStore {
  readonly subscriptionsTable: string;
  readonly deliveriesTable: string;

  constructor(private readonly options: PgWebPushStoreOptions) {
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.subscriptionsTable = `${prefix}_web_push_subscriptions`;
    this.deliveriesTable = `${prefix}_web_push_deliveries`;
  }

  async init(): Promise<void> {
    const lockKey = `${this.subscriptionsTable}:init`;
    const client = await this.options.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.subscriptionsTable} (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          endpoint_hash TEXT NOT NULL UNIQUE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          device_name TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.deliveriesTable} (
          subscription_id TEXT NOT NULL REFERENCES ${this.subscriptionsTable}(id) ON DELETE CASCADE,
          event_key TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (subscription_id, event_key)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.subscriptionsTable}_owner_idx `
        + `ON ${this.subscriptionsTable} (tenant_id, user_id, updated_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.deliveriesTable}_created_idx `
        + `ON ${this.deliveriesTable} (created_at)`,
      );
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async list(owner: WebPushOwner): Promise<WebPushSubscriptionRecord[]> {
    const result = await this.options.pool.query<SubscriptionRow>(`
      SELECT id, tenant_id, user_id, endpoint, endpoint_hash, p256dh, auth, device_name, created_at, updated_at
      FROM ${this.subscriptionsTable}
      WHERE tenant_id=$1 AND user_id=$2
      ORDER BY updated_at DESC, id
    `, [owner.tenantId, owner.userId]);
    return result.rows.map(mapRow);
  }

  async save(owner: WebPushOwner, input: WebPushSubscriptionInput): Promise<WebPushSubscriptionRecord> {
    const endpointHash = hashEndpoint(input.endpoint);
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [owner.tenantId, owner.userId]);
      const existing = await client.query<SubscriptionRow>(`
        SELECT id, tenant_id, user_id, endpoint, endpoint_hash, p256dh, auth, device_name, created_at, updated_at
        FROM ${this.subscriptionsTable}
        WHERE endpoint_hash=$1
        FOR UPDATE
      `, [endpointHash]);
      const row = existing.rows[0];
      const id = row?.id ?? randomUUID();
      const alreadyOwned = row?.tenant_id === owner.tenantId && row.user_id === owner.userId;
      if (!alreadyOwned) {
        const count = await client.query<{ count: string }>(`
          SELECT count(*)::text AS count
          FROM ${this.subscriptionsTable}
          WHERE tenant_id=$1 AND user_id=$2
        `, [owner.tenantId, owner.userId]);
        if (Number(count.rows[0]?.count ?? 0) >= MAX_SUBSCRIPTIONS_PER_USER) {
          throw new Error(`每个账号最多绑定 ${MAX_SUBSCRIPTIONS_PER_USER} 台浏览器设备`);
        }
      }

      if (row && !alreadyOwned) {
        await client.query(`DELETE FROM ${this.deliveriesTable} WHERE subscription_id=$1`, [id]);
      }

      const saved = await client.query<SubscriptionRow>(`
        INSERT INTO ${this.subscriptionsTable}
          (id, tenant_id, user_id, endpoint, endpoint_hash, p256dh, auth, device_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (endpoint_hash) DO UPDATE SET
          tenant_id=EXCLUDED.tenant_id,
          user_id=EXCLUDED.user_id,
          endpoint=EXCLUDED.endpoint,
          p256dh=EXCLUDED.p256dh,
          auth=EXCLUDED.auth,
          device_name=EXCLUDED.device_name,
          updated_at=now()
        RETURNING id, tenant_id, user_id, endpoint, endpoint_hash, p256dh, auth, device_name, created_at, updated_at
      `, [id, owner.tenantId, owner.userId, input.endpoint, endpointHash, input.keys.p256dh, input.keys.auth, input.deviceName]);
      await client.query('COMMIT');
      return mapRow(saved.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(owner: WebPushOwner, subscriptionId: string): Promise<boolean> {
    const result = await this.options.pool.query(
      `DELETE FROM ${this.subscriptionsTable} WHERE id=$1 AND tenant_id=$2 AND user_id=$3`,
      [subscriptionId, owner.tenantId, owner.userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async claimDelivery(
    owner: WebPushOwner,
    expected: WebPushSubscriptionRecord,
    eventKey: string,
  ): Promise<WebPushDeliveryClaim | WebPushDeliveryDeferred | null> {
    const client = await this.options.pool.connect();
    let closed = false;
    const close = async (commit: boolean) => {
      if (closed) return;
      closed = true;
      await client.query(commit ? 'COMMIT' : 'ROLLBACK').catch(() => undefined);
      client.release();
    };

    try {
      await client.query('BEGIN');
      const current = await client.query<SubscriptionRow>(`
        SELECT id, tenant_id, user_id, endpoint, endpoint_hash, p256dh, auth, device_name, created_at, updated_at
        FROM ${this.subscriptionsTable}
        WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND endpoint_hash=$4 AND updated_at=$5::timestamptz
        FOR UPDATE
      `, [expected.id, owner.tenantId, owner.userId, expected.endpointHash, expected.updatedAt]);
      if (!current.rows[0]) {
        await close(false);
        return null;
      }

      const claimed = await client.query(`
        INSERT INTO ${this.deliveriesTable} (subscription_id, event_key, status)
        VALUES ($1,$2,'pending')
        ON CONFLICT (subscription_id, event_key) DO UPDATE SET
          status='pending', error=NULL, updated_at=now()
        WHERE (${this.deliveriesTable}.status='failed'
            AND ${this.deliveriesTable}.updated_at < now() - interval '1 minute')
          OR (${this.deliveriesTable}.status='pending'
            AND ${this.deliveriesTable}.updated_at < now() - interval '15 minutes')
        RETURNING subscription_id
      `, [expected.id, eventKey]);
      if ((claimed.rowCount ?? 0) === 0) {
        const existing = await client.query<{ status: string }>(
          `SELECT status FROM ${this.deliveriesTable} WHERE subscription_id=$1 AND event_key=$2`,
          [expected.id, eventKey],
        );
        await close(false);
        return existing.rows[0]?.status === 'failed' || existing.rows[0]?.status === 'pending'
          ? { deferred: true }
          : null;
      }

      return {
        subscription: mapRow(current.rows[0]),
        finish: async (status, error) => {
          if (closed) return;
          try {
            await client.query(`
              UPDATE ${this.deliveriesTable}
              SET status=$3, error=$4, updated_at=now()
              WHERE subscription_id=$1 AND event_key=$2
            `, [expected.id, eventKey, status, error ?? null]);
            await close(true);
          } catch (finishError) {
            await close(false);
            throw finishError;
          }
        },
        invalidate: async () => {
          if (closed) return;
          try {
            await client.query(
              `DELETE FROM ${this.subscriptionsTable} WHERE id=$1 AND tenant_id=$2 AND user_id=$3`,
              [expected.id, owner.tenantId, owner.userId],
            );
            await close(true);
          } catch (invalidateError) {
            await close(false);
            throw invalidateError;
          }
        },
      };
    } catch (error) {
      await close(false);
      throw error;
    }
  }
}

export function hashEndpoint(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

function mapRow(row: SubscriptionRow): WebPushSubscriptionRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    endpoint: row.endpoint,
    endpointHash: row.endpoint_hash,
    p256dh: row.p256dh,
    auth: row.auth,
    deviceName: row.device_name,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`非法 PG tablePrefix: ${value}`);
  return value;
}
