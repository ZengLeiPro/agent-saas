/** 数据库连接与迁移。契约包自带的表由 `ensureKyAppSchema()` 建，业务表走本目录的 SQL。 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Pool } from 'pg';

import { ensureKyAppSchema } from '@kaiyan/ky-app-server';

import { migrationsDir } from './paths.js';

/** 首连重试次数（不含第一次尝试）与间隔。 */
export const DB_CONNECT_RETRIES = 10;
export const DB_CONNECT_RETRY_INTERVAL_MS = 500;

/**
 * 只有「连接类」错误才重试：数据库容器刚起、端口刚开、实例还在 initdb / recovery 时，
 * 首连会拿到 ECONNRESET、Connection terminated 或 `the database system is starting up`。
 * SQL 语法、权限、约束一类错误不在此列，必须原样抛出。
 */
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '53300',
  '57P01',
  '57P02',
  '57P03',
  '57P04',
]);

const TRANSIENT_MESSAGE_PATTERNS = [
  /connection terminated/iu,
  /connection reset/iu,
  /socket hang up/iu,
  /timeout exceeded when trying to connect/iu,
  /server closed the connection unexpectedly/iu,
  /the database system is (?:starting up|shutting down|in recovery)/iu,
];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 判定是不是「库还没准备好」这类可重试的连接错误。 */
export function isConnectionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code)) return true;
  const message = messageOf(error);
  return TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

export function createPool(databaseUrl: string): Pool {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  // pg 要求给连接池挂 error 监听，否则空闲连接被服务端断开时会变成未捕获异常。
  pool.on('error', (error) => {
    console.error(`数据库空闲连接出错：${messageOf(error)}`);
  });
  return pool;
}

/**
 * 等数据库真的可连：跑一条 `SELECT 1`，连接类错误最多重试 `retries` 次、间隔 500 ms，
 * 仍失败才把原始错误抛出去（由调用方打印原因并退出）。运行期的正常错误一律不吞。
 */
export async function waitForDatabase(
  pool: Pool,
  options: { retries?: number; intervalMs?: number; log?: (line: string) => void } = {},
): Promise<void> {
  const retries = options.retries ?? DB_CONNECT_RETRIES;
  const intervalMs = options.intervalMs ?? DB_CONNECT_RETRY_INTERVAL_MS;
  const log =
    options.log ??
    ((line: string): void => {
      console.error(line);
    });

  for (let attempt = 0; ; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      if (attempt > 0) log(`数据库连接成功（第 ${String(attempt + 1)} 次尝试）`);
      return;
    } catch (error) {
      if (attempt >= retries || !isConnectionError(error)) throw error;
      log(
        `数据库暂时连不上，${String(intervalMs)} ms 后重试` +
          `（${String(attempt + 1)}/${String(retries)}）：${messageOf(error)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

/**
 * 建表（可重复执行）：
 * 1. `@kaiyan/ky-app-server` 的 `sql/001_ky_app_server.sql`（jti / 执行记录 / 事件 / 目录 / 兜底）；
 * 2. 本项目 `server/migrations/*.sql`，按文件名排序。
 */
export async function runMigrations(pool: Pool): Promise<string[]> {
  await ensureKyAppSchema(pool);
  const dir = migrationsDir();
  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    await pool.query(await readFile(join(dir, file), 'utf8'));
  }
  return files;
}
