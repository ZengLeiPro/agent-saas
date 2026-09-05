/**
 * PG 存储的建表入口。生产环境应把 `sql/001_ky_app_server.sql` 纳入项目自己的迁移体系
 * （expand-only，§8.3）；这里提供一个直接执行该文件的便捷函数，供 doctor 与测试使用。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';

/** 迁移文件相对包根的路径（已随 `files` 一起发布）。 */
export const MIGRATION_FILES = ['sql/001_ky_app_server.sql'] as const;

function migrationUrl(file: string): URL {
  // dist/pg/schema.js → 包根，src/pg/schema.ts → 包根，两种布局都退两级。
  return new URL(`../../${file}`, import.meta.url);
}

/** 读取迁移 SQL 文本。 */
export async function readMigrations(): Promise<string[]> {
  return Promise.all(
    MIGRATION_FILES.map((file) => readFile(fileURLToPath(migrationUrl(file)), 'utf8')),
  );
}

/** 建表（可重复执行）。 */
export async function ensureKyAppSchema(pool: Pool): Promise<void> {
  for (const sql of await readMigrations()) {
    await pool.query(sql);
  }
}
