/**
 * §3.1-6 / §9.3-4 `jti` 跨进程单次消费（PostgreSQL）。
 *
 * 需要 `TEST_DATABASE_URL`；缺失时整组 skip 并打印原因（CI 的 postgres 任务会提供）。
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgJtiStore } from './pgJtiStore.js';
import { ensureKyAppSchema } from '../pg/schema.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = typeof databaseUrl === 'string' && databaseUrl !== '';

if (!enabled) {
  console.warn(
    '[ky-app-server] 跳过 PgJtiStore 用例：未设置 TEST_DATABASE_URL（CI 的 postgres 任务会提供）',
  );
}

const WORKER = fileURLToPath(new URL('./__tests__/pgJtiWorker.mjs', import.meta.url));

/** 在独立进程里消费一次 `jti`，返回是否插入成功。 */
function consumeInChildProcess(jti: string, expiresAt: Date): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [databaseUrl ?? '', jti, expiresAt.toISOString()], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', () => {
      try {
        const parsed = JSON.parse(out.trim()) as { inserted?: boolean; error?: string };
        if (parsed.error !== undefined) reject(new Error(parsed.error));
        else resolve(parsed.inserted === true);
      } catch (error) {
        reject(new Error(`worker 输出不可解析：${out}｜${String(error)}`));
      }
    });
  });
}

describe.skipIf(!enabled)('PgJtiStore（需要 TEST_DATABASE_URL）', () => {
  let pool: pg.Pool;
  let store: PgJtiStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
    await ensureKyAppSchema(pool);
    await pool.query('DELETE FROM ky_app_jti');
    store = new PgJtiStore(pool, { purgeIntervalMs: 0 });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  function future(seconds = 120): Date {
    return new Date(Date.now() + seconds * 1000);
  }

  it('串行重放：第二次 consume 返回 false（调用方回 401 token_replayed）', async () => {
    const jti = `serial-${String(Date.now())}`;
    expect(await store.consume(jti, future())).toBe(true);
    expect(await store.consume(jti, future())).toBe(false);
  });

  it('并发 10 次恰 1 次成功', async () => {
    const jti = `concurrent-${String(Date.now())}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.consume(jti, future())),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('双进程：两个独立进程同时消费同一个 jti，恰 1 次成功', async () => {
    const jti = `two-process-${String(Date.now())}`;
    const expiresAt = future();
    const results = await Promise.all([
      consumeInChildProcess(jti, expiresAt),
      consumeInChildProcess(jti, expiresAt),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  }, 60_000);

  it('存储重启（新建连接池）后仍然拒绝重放', async () => {
    const jti = `restart-${String(Date.now())}`;
    expect(await store.consume(jti, future())).toBe(true);

    const reopened = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const restarted = new PgJtiStore(reopened, { purgeIntervalMs: 0 });
      expect(await restarted.consume(jti, future())).toBe(false);
    } finally {
      await reopened.end();
    }
  });

  it('过期占用被清理后可以再次占用', async () => {
    const jti = `expired-${String(Date.now())}`;
    expect(await store.consume(jti, new Date(Date.now() - 1000))).toBe(true);
    expect(await store.consume(jti, future())).toBe(false);
    expect(await store.purgeExpired()).toBeGreaterThanOrEqual(1);
    expect(await store.consume(jti, future())).toBe(true);
  });
});
