/** 数据库连接与迁移。契约包自带的表由 `ensureKyAppSchema()` 建，业务表走本目录的 SQL。 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Pool } from 'pg';

import { ensureKyAppSchema } from '@kaiyan/ky-app-server';

import { migrationsDir } from './paths.js';

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 8 });
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
