// release-migration: expand
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

import type { ApnsEnvironment } from '../app/pushConfigSchema.js';
import type { PushOwner } from '../push/sender.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;
const MAX_DEVICES_PER_USER = 20;

export interface ApnsDeviceInput {
  /** APNs 设备令牌（hex）。 */
  token: string;
  environment: ApnsEnvironment;
  deviceName: string;
  appVersion?: string;
}

export interface ApnsDeviceRecord extends PushOwner {
  id: string;
  token: string;
  tokenHash: string;
  environment: ApnsEnvironment;
  deviceName: string;
  appVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DeviceRow {
  id: string;
  tenant_id: string;
  user_id: string;
  token: string;
  token_hash: string;
  environment: string;
  device_name: string;
  app_version: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface PgApnsDeviceStoreOptions {
  pool: PgPool;
  tablePrefix?: string;
}

export interface ApnsDeliveryClaim {
  device: ApnsDeviceRecord;
  finish(status: 'sent' | 'failed', error?: string): Promise<void>;
  invalidate(): Promise<void>;
}

export interface ApnsDeliveryDeferred {
  deferred: true;
}

const DEVICE_COLUMNS =
  'id, tenant_id, user_id, token, token_hash, environment, device_name, app_version, created_at, updated_at';

/**
 * iOS 设备推送令牌与投递幂等记录。
 *
 * 令牌是 Apple 为「App × 设备」签发的能力凭证，全局唯一；同一台设备换账号登录时
 * 原子重绑到当前身份，退出登录后不再向旧账号串发。投递表不建外键：删除设备时
 * 在同一事务内显式清理，避免启动建表语句带上级联删除语义。
 */
export class PgApnsDeviceStore {
  readonly devicesTable: string;
  readonly deliveriesTable: string;

  constructor(private readonly options: PgApnsDeviceStoreOptions) {
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.devicesTable = `${prefix}_apns_devices`;
    this.deliveriesTable = `${prefix}_apns_deliveries`;
  }

  async init(): Promise<void> {
    const lockKey = `${this.devicesTable}:init`;
    const client = await this.options.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.devicesTable} (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          token TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
          device_name TEXT NOT NULL,
          app_version TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.deliveriesTable} (
          device_id TEXT NOT NULL,
          event_key TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (device_id, event_key)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.devicesTable}_owner_idx ` +
          `ON ${this.devicesTable} (tenant_id, user_id, updated_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.deliveriesTable}_created_idx ` +
          `ON ${this.deliveriesTable} (created_at)`,
      );
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey])
        .catch(() => undefined);
      client.release();
    }
  }

  async list(owner: PushOwner): Promise<ApnsDeviceRecord[]> {
    const result = await this.options.pool.query<DeviceRow>(
      `
      SELECT ${DEVICE_COLUMNS}
      FROM ${this.devicesTable}
      WHERE tenant_id=$1 AND user_id=$2
      ORDER BY updated_at DESC, id
    `,
      [owner.tenantId, owner.userId],
    );
    return result.rows.map(mapRow);
  }

  async save(owner: PushOwner, input: ApnsDeviceInput): Promise<ApnsDeviceRecord> {
    const tokenHash = hashDeviceToken(input.token);
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        owner.tenantId,
        owner.userId,
      ]);
      const existing = await client.query<DeviceRow>(
        `
        SELECT ${DEVICE_COLUMNS}
        FROM ${this.devicesTable}
        WHERE token_hash=$1
        FOR UPDATE
      `,
        [tokenHash],
      );
      const row = existing.rows[0];
      const id = row?.id ?? randomUUID();
      const alreadyOwned = row?.tenant_id === owner.tenantId && row.user_id === owner.userId;
      if (!alreadyOwned) {
        const count = await client.query<{ count: string }>(
          `
          SELECT count(*)::text AS count
          FROM ${this.devicesTable}
          WHERE tenant_id=$1 AND user_id=$2
        `,
          [owner.tenantId, owner.userId],
        );
        if (Number(count.rows[0]?.count ?? 0) >= MAX_DEVICES_PER_USER) {
          throw new Error(`每个账号最多绑定 ${MAX_DEVICES_PER_USER} 台 iOS 设备`);
        }
      }

      // 换账号：旧身份的投递记录不再有意义，避免新账号的同名事件被误判为已投递。
      if (row && !alreadyOwned) {
        await client.query(`DELETE FROM ${this.deliveriesTable} WHERE device_id=$1`, [id]);
      }

      const saved = await client.query<DeviceRow>(
        `
        INSERT INTO ${this.devicesTable}
          (id, tenant_id, user_id, token, token_hash, environment, device_name, app_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (token_hash) DO UPDATE SET
          tenant_id=EXCLUDED.tenant_id,
          user_id=EXCLUDED.user_id,
          token=EXCLUDED.token,
          environment=EXCLUDED.environment,
          device_name=EXCLUDED.device_name,
          app_version=EXCLUDED.app_version,
          updated_at=now()
        RETURNING ${DEVICE_COLUMNS}
      `,
        [
          id,
          owner.tenantId,
          owner.userId,
          input.token,
          tokenHash,
          input.environment,
          input.deviceName,
          input.appVersion ?? null,
        ],
      );
      await client.query('COMMIT');
      return mapRow(saved.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(owner: PushOwner, deviceId: string): Promise<boolean> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `DELETE FROM ${this.devicesTable} WHERE id=$1 AND tenant_id=$2 AND user_id=$3`,
        [deviceId, owner.tenantId, owner.userId],
      );
      const deleted = (result.rowCount ?? 0) > 0;
      if (deleted) {
        await client.query(`DELETE FROM ${this.deliveriesTable} WHERE device_id=$1`, [deviceId]);
      }
      await client.query('COMMIT');
      return deleted;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimDelivery(
    owner: PushOwner,
    expected: ApnsDeviceRecord,
    eventKey: string,
  ): Promise<ApnsDeliveryClaim | ApnsDeliveryDeferred | null> {
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
      const current = await client.query<DeviceRow>(
        `
        SELECT ${DEVICE_COLUMNS}
        FROM ${this.devicesTable}
        WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND token_hash=$4 AND updated_at=$5::timestamptz
        FOR UPDATE
      `,
        [expected.id, owner.tenantId, owner.userId, expected.tokenHash, expected.updatedAt],
      );
      if (!current.rows[0]) {
        await close(false);
        return null;
      }

      const claimed = await client.query(
        `
        INSERT INTO ${this.deliveriesTable} (device_id, event_key, status)
        VALUES ($1,$2,'pending')
        ON CONFLICT (device_id, event_key) DO UPDATE SET
          status='pending', error=NULL, updated_at=now()
        WHERE (${this.deliveriesTable}.status='failed'
            AND ${this.deliveriesTable}.updated_at < now() - interval '1 minute')
          OR (${this.deliveriesTable}.status='pending'
            AND ${this.deliveriesTable}.updated_at < now() - interval '15 minutes')
        RETURNING device_id
      `,
        [expected.id, eventKey],
      );
      if ((claimed.rowCount ?? 0) === 0) {
        const existing = await client.query<{ status: string }>(
          `SELECT status FROM ${this.deliveriesTable} WHERE device_id=$1 AND event_key=$2`,
          [expected.id, eventKey],
        );
        await close(false);
        return existing.rows[0]?.status === 'failed' || existing.rows[0]?.status === 'pending'
          ? { deferred: true }
          : null;
      }

      return {
        device: mapRow(current.rows[0]),
        finish: async (status, error) => {
          if (closed) return;
          try {
            await client.query(
              `
              UPDATE ${this.deliveriesTable}
              SET status=$3, error=$4, updated_at=now()
              WHERE device_id=$1 AND event_key=$2
            `,
              [expected.id, eventKey, status, error ?? null],
            );
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
              `DELETE FROM ${this.devicesTable} WHERE id=$1 AND tenant_id=$2 AND user_id=$3`,
              [expected.id, owner.tenantId, owner.userId],
            );
            await client.query(`DELETE FROM ${this.deliveriesTable} WHERE device_id=$1`, [
              expected.id,
            ]);
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

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function mapRow(row: DeviceRow): ApnsDeviceRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    token: row.token,
    tokenHash: row.token_hash,
    environment: row.environment === 'sandbox' ? 'sandbox' : 'production',
    deviceName: row.device_name,
    appVersion: row.app_version,
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
