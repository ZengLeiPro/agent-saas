/**
 * Single-writer guard for runtime sessions: PG session-level advisory lock per sessionId.
 *
 * 用途：路线 §8 阶段 2 完成判据之一——"同一 session 同时只有一个 brain
 * 可持有执行权"。通过 `pg_try_advisory_lock(bigint)` 实现：
 *   - 锁随**持锁 connection** 走，brain 进程 crash / 网络断开 → PG 自动释放
 *   - 非阻塞 try：拿不到立刻返回 `null`，调用方决定是退让还是排队
 *   - 显式 `release()` 走 `pg_advisory_unlock` + 归还 client 到 pool
 *
 * 设计取舍：
 *   - **每次 tryAcquire 占用一个 pool client**：锁的语义需要 lock 跟 connection
 *     一一绑定；如果用 transient query 模式（自动归还 client），PG session 一断
 *     锁就丢了，等于没锁。代价是：每个 active session 都常驻一个 PG 连接，
 *     `agent_runtime_app` 的 `CONNECTION LIMIT 20` 是上限阈值。生产观察后再
 *     调（α6 launchd 已稳，brain 单实例下 active session 数 ≈ 并发用户数）。
 *   - **key 用 sessionId 的 SHA-1 前 8 字节读为 signed bigint**：单 brain 同时
 *     持有的 session 数 << 2^32，碰撞概率按生日攻击可忽略；不为了消除碰撞
 *     上 2-arg advisory lock（避免 sessionId 拆分歧义）。
 *   - **release 幂等且不抛**：handle 上多次 release 安全，第 2+ 次 no-op；
 *     `pg_advisory_unlock` 万一报错（session 已断 / 锁已失）吞掉，避免 release
 *     失败把上层路径污染。
 *
 * 阶段 2 不集成进 raw runtime（路线 §8.5 R2 阶段 2 留 advisory lock，应用级
 * 集成等 Task 12 Stage 2 资产 bug 解决后做，即 α3b）。本模块先单独验收。
 */
import { createHash } from 'node:crypto';

import type pg from 'pg';

// pg.Pool.connect() 的非 callback overload 返回 PoolClient；直接取 named type，
// 不要走 Awaited<ReturnType<...>>（会撞到 callback overload 推导成 void）。
type PgPoolClient = pg.PoolClient;

export interface PgSessionLockHandle {
  /**
   * 释放锁并归还 connection。可重复调用，第 2+ 次为 no-op。
   * 任何内部错误都被吞掉（PG 端 session 断开时 unlock 会报错，那是正常的）。
   */
  release(): Promise<void>;
  /** 是否已释放。 */
  readonly released: boolean;
  /** 用于诊断 / 测试：lock key（sessionId 哈希后的 bigint）。 */
  readonly key: bigint;
}

export interface PgSessionLockOptions {
  pool: pg.Pool;
}

export class PgSessionLock {
  private readonly pool: pg.Pool;

  constructor(options: PgSessionLockOptions) {
    this.pool = options.pool;
  }

  /**
   * 非阻塞地尝试获取 sessionId 的 advisory lock。
   * - 拿到 → 返回 handle，调用方必须最终 release（或让 brain crash 让 PG 自动释放）
   * - 未拿到 → 返回 null
   */
  async tryAcquire(sessionId: string): Promise<PgSessionLockHandle | null> {
    if (!sessionId) {
      throw new Error('PgSessionLock.tryAcquire: sessionId is required');
    }
    const key = sessionIdToLockKey(sessionId);
    const client = await this.pool.connect();
    let acquired = false;
    try {
      const result = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        [key.toString()],
      );
      acquired = result.rows[0]?.acquired === true;
    } catch (err) {
      client.release();
      throw err;
    }
    if (!acquired) {
      client.release();
      return null;
    }
    return makeHandle(client, key);
  }
}

function makeHandle(client: PgPoolClient, key: bigint): PgSessionLockHandle {
  let released = false;
  return {
    get released() {
      return released;
    },
    get key() {
      return key;
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [key.toString()]);
      } catch {
        // 已断开 / 已自动释放 / network blip：忽略，仍然归还 client
      } finally {
        client.release();
      }
    },
  };
}

/**
 * sessionId（通常是 UUID 字符串，也兼容任意非空字符串）→ signed bigint key。
 *
 * 用 SHA-1 前 8 字节读成 signed 64-bit。原因：
 *  - PG advisory lock 的 key 是 bigint（signed）
 *  - SHA-1 输出 20 字节，丢弃后 12 字节足够分散
 *  - 跨语言可复现：未来 ECS 上多 brain 用同样的 hash 算法即可
 */
export function sessionIdToLockKey(sessionId: string): bigint {
  const digest = createHash('sha1').update(sessionId, 'utf-8').digest();
  return digest.readBigInt64BE(0);
}
