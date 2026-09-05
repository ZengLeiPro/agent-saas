#!/usr/bin/env node
/** `pnpm migrate`：只跑迁移然后退出。 */
import { createPool, runMigrations } from './db.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === '') {
  console.error('缺少 DATABASE_URL');
  process.exit(1);
}
const pool = createPool(databaseUrl);
const files = await runMigrations(pool);
console.log(`迁移完成：契约包表 + ${files.join('、')}`);
await pool.end();
