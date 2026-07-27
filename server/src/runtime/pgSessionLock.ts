/**
 * Runtime session single-writer guard.
 *
 * 最终形态使用 PG 表租约：每次 acquire/renew/release 都是短查询，不再让每个
 * active session 常驻占用一条 shared pool connection。brain crash 后租约自然
 * 过期，其他实例可接管；正常运行时定期续约，确认所有权丢失后通知 dispatch abort。
 *
 * 蓝绿迁移必须分两阶段：
 * - dual（默认）：同时持有旧 advisory lock + 新表租约，兼容尚未升级的旧实例；
 * - lease：只持表租约，彻底取消 active session 的常驻 PG connection。
 *
 * 先完整发布 dual，再把生产 config.runtimeScheduler.sessionLockMode 切到 lease
 * 发布第二次。dual 与 lease 都认识表租约，因此第二次蓝绿重叠仍然安全。
 */
import { createHash, randomUUID } from 'node:crypto';

import type pg from 'pg';

type PgPoolClient = pg.PoolClient;

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_RENEW_INTERVAL_MS = 30_000;
const MIN_LEASE_MS = 10_000;
const MIN_RENEW_INTERVAL_MS = 1_000;

export type PgSessionLockMode = 'dual' | 'lease';

export interface PgSessionLockAcquireOptions {
  /** 租约确认丢失或续约持续失败直至过期时，通知 dispatch 立即中止当前 run。 */
  onLost?: (reason: Error) => void;
}

export interface PgSessionLockHandle {
  /**
   * 释放表租约；dual 模式同时释放旧 advisory lock 并归还 connection。
   * 可重复调用，第 2+ 次为 no-op；内部清理失败不向运行收尾路径抛出。
   */
  release(): Promise<void>;
  readonly released: boolean;
  /** sessionId 哈希后的 legacy advisory key，仅用于诊断与兼容。 */
  readonly key: bigint;
}

export interface PgSessionLockOptions {
  pool: pg.Pool;
  tablePrefix?: string;
  mode?: PgSessionLockMode;
  leaseMs?: number;
  renewIntervalMs?: number;
  logger?: {
    warn?(message: string, meta?: Record<string, unknown>): void;
  };
}

interface LeaseRow {
  lease_expires_at: Date | string;
}

export class PgSessionLock {
  private readonly pool: pg.Pool;
  private readonly leasesTable: string;
  private readonly mode: PgSessionLockMode;
  private readonly leaseMs: number;
  private readonly renewIntervalMs: number;
  private readonly handles = new Set<PgSessionLockHandle>();

  constructor(private readonly options: PgSessionLockOptions) {
    this.pool = options.pool;
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.leasesTable = `${prefix}_session_leases`;
    this.mode = options.mode ?? 'dual';
    this.leaseMs = Math.max(MIN_LEASE_MS, Math.floor(options.leaseMs ?? DEFAULT_LEASE_MS));
    this.renewIntervalMs = Math.min(
      Math.max(MIN_RENEW_INTERVAL_MS, Math.floor(options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS)),
      Math.max(MIN_RENEW_INTERVAL_MS, Math.floor(this.leaseMs / 3)),
    );
  }

  async init(): Promise<void> {
    const lockKey = `${this.leasesTable}:init`;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.leasesTable} (
          session_id TEXT PRIMARY KEY,
          owner_token TEXT NOT NULL,
          lease_expires_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  /**
   * 非阻塞尝试获取 session 执行权。
   * - dual：先拿旧 advisory lock，再拿表租约；
   * - lease：只用一次原子 UPSERT 获取表租约，不持有 connection。
   */
  async tryAcquire(
    sessionId: string,
    acquireOptions: PgSessionLockAcquireOptions = {},
  ): Promise<PgSessionLockHandle | null> {
    if (!sessionId) {
      throw new Error('PgSessionLock.tryAcquire: sessionId is required');
    }

    const key = sessionIdToLockKey(sessionId);
    let legacyClient: PgPoolClient | undefined;
    if (this.mode === 'dual') {
      legacyClient = await this.pool.connect();
      try {
        const result = await legacyClient.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
          [key.toString()],
        );
        if (result.rows[0]?.acquired !== true) {
          legacyClient.release();
          return null;
        }
      } catch (err) {
        legacyClient.release();
        throw err;
      }
    }

    const ownerToken = randomUUID();
    let acquired: LeaseRow | undefined;
    try {
      const result = await this.pool.query<LeaseRow>(`
        INSERT INTO ${this.leasesTable}
          (session_id, owner_token, lease_expires_at, updated_at)
        VALUES (
          $1,
          $2,
          clock_timestamp() + ($3::bigint * INTERVAL '1 millisecond'),
          clock_timestamp()
        )
        ON CONFLICT (session_id) DO UPDATE
        SET owner_token = EXCLUDED.owner_token,
            lease_expires_at = EXCLUDED.lease_expires_at,
            updated_at = EXCLUDED.updated_at
        WHERE ${this.leasesTable}.lease_expires_at <= clock_timestamp()
        RETURNING lease_expires_at
      `, [sessionId, ownerToken, this.leaseMs]);
      acquired = result.rows[0];
    } catch (err) {
      await releaseLegacyLock(legacyClient, key);
      throw err;
    }

    if (!acquired) {
      await releaseLegacyLock(legacyClient, key);
      return null;
    }

    let handle: PgSessionLockHandle;
    handle = makeLeaseHandle({
      pool: this.pool,
      leasesTable: this.leasesTable,
      sessionId,
      ownerToken,
      key,
      legacyClient,
      leaseMs: this.leaseMs,
      renewIntervalMs: this.renewIntervalMs,
      initialExpiresAt: acquired.lease_expires_at,
      onLost: acquireOptions.onLost,
      logger: this.options.logger,
      onReleased: () => this.handles.delete(handle),
    });
    this.handles.add(handle);
    return handle;
  }

  /** shutdown 兜底：停止全部续约并尽力释放当前实例仍持有的租约。 */
  async close(): Promise<void> {
    await Promise.allSettled([...this.handles].map((handle) => handle.release()));
    this.handles.clear();
  }
}

function makeLeaseHandle(input: {
  pool: pg.Pool;
  leasesTable: string;
  sessionId: string;
  ownerToken: string;
  key: bigint;
  legacyClient?: PgPoolClient;
  leaseMs: number;
  renewIntervalMs: number;
  initialExpiresAt: Date | string;
  onLost?: (reason: Error) => void;
  logger?: PgSessionLockOptions['logger'];
  onReleased(): void;
}): PgSessionLockHandle {
  let released = false;
  let lost = false;
  let renewInFlight = false;
  let expiresAtMs = toTimestamp(input.initialExpiresAt);
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  const lose = (reason: Error): void => {
    if (released || lost) return;
    lost = true;
    input.logger?.warn?.('PG session lease lost', {
      sessionId: input.sessionId,
      error: reason.message,
    });
    input.onLost?.(reason);
  };

  const scheduleExpiry = (): void => {
    if (expiryTimer) clearTimeout(expiryTimer);
    const delayMs = Math.max(0, expiresAtMs - Date.now() + 10);
    expiryTimer = setTimeout(() => {
      lose(new Error(`PG session lease expired: ${input.sessionId}`));
    }, delayMs);
    expiryTimer.unref?.();
  };

  scheduleExpiry();
  const renewTimer = setInterval(() => {
    if (released || lost || renewInFlight) return;
    renewInFlight = true;
    void input.pool.query<LeaseRow>(`
      UPDATE ${input.leasesTable}
      SET lease_expires_at = clock_timestamp() + ($3::bigint * INTERVAL '1 millisecond'),
          updated_at = clock_timestamp()
      WHERE session_id = $1
        AND owner_token = $2
        AND lease_expires_at > clock_timestamp()
      RETURNING lease_expires_at
    `, [input.sessionId, input.ownerToken, input.leaseMs])
      .then((result) => {
        const renewed = result.rows[0];
        if (!renewed) {
          lose(new Error(`PG session lease ownership lost: ${input.sessionId}`));
          return;
        }
        expiresAtMs = toTimestamp(renewed.lease_expires_at);
        scheduleExpiry();
      })
      .catch((err) => {
        input.logger?.warn?.('PG session lease renew failed', {
          sessionId: input.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        // 短暂数据库错误不立即制造双跑；保留原过期计时器，持续失败到截止点才 abort。
      })
      .finally(() => {
        renewInFlight = false;
      });
  }, input.renewIntervalMs);
  renewTimer.unref?.();

  return {
    get released() {
      return released;
    },
    get key() {
      return input.key;
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      clearInterval(renewTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
      try {
        await input.pool.query(`
          DELETE FROM ${input.leasesTable}
          WHERE session_id = $1 AND owner_token = $2
        `, [input.sessionId, input.ownerToken]);
      } catch (err) {
        input.logger?.warn?.('PG session lease release failed', {
          sessionId: input.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        await releaseLegacyLock(input.legacyClient, input.key);
        input.onReleased();
      }
    },
  };
}

async function releaseLegacyLock(client: PgPoolClient | undefined, key: bigint): Promise<void> {
  if (!client) return;
  try {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [key.toString()]);
  } catch {
    // connection 已断 / PG 已自动释放：仍必须归还 pool client。
  } finally {
    client.release();
  }
}

function toTimestamp(value: Date | string): number {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid PG session lease expiry: ${String(value)}`);
  }
  return timestamp;
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`非法 PG tablePrefix: ${value}`);
  }
  return value;
}

/**
 * sessionId（通常是 UUID，也兼容任意非空字符串）→ signed bigint advisory key。
 * dual 迁移期沿用旧 SHA-1 前 8 字节算法，确保新旧实例竞争同一 legacy lock。
 */
export function sessionIdToLockKey(sessionId: string): bigint {
  const digest = createHash('sha1').update(sessionId, 'utf-8').digest();
  return digest.readBigInt64BE(0);
}
