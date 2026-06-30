/**
 * Business SQLite — 共享业务数据库
 *
 * 与 per-user `memory-index/{username}.sqlite` 区分：
 *   - memory-index：每个用户一个 db，存记忆向量与 FTS5 索引
 *   - business.sqlite：全局唯一 db，存跨用户的业务事务/分析数据（当前仅 token 用量统计）
 *
 * 设计原则：
 *   - 单例 DatabaseSync 句柄，进程内复用
 *   - WAL 模式 + busy_timeout 5000，与 memory-index 一致
 *   - schema 通过 migrations.ts 管理，支持版本递进
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

let _db: DatabaseSync | null = null;
let _dbPath: string | null = null;

/**
 * 获取共享业务 DB 句柄（单例）。
 *
 * @param dataDir 业务数据目录（一般为 <processCwd>/data）
 * @returns DatabaseSync 句柄
 */
export function getBusinessDb(dataDir: string): DatabaseSync {
  if (_db) return _db;

  const dbDir = resolve(dataDir);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }
  const dbPath = join(dbDir, 'business.sqlite');

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');

  _db = db;
  _dbPath = dbPath;
  return db;
}

/** 当前 business.sqlite 物理路径（getBusinessDb 调用后才有值） */
export function getBusinessDbPath(): string | null {
  return _dbPath;
}

/** 关闭句柄并清理单例（仅在 shutdown 路径调用） */
export function closeBusinessDb(): void {
  try {
    _db?.close();
  } catch {
    // ignore close errors during shutdown
  }
  _db = null;
  _dbPath = null;
}

// 内部测试用：允许测试代码重置单例
export function __resetBusinessDbForTest(): void {
  closeBusinessDb();
}

// 辅助：把可能含 ~ 的路径展开到绝对路径（migrations / rebuild 用得到）
export function resolveDataPath(dataDir: string, sub: string): string {
  return resolve(dataDir, sub);
}

// 暴露 dirname 与 join，避免外部模块重复 import path
export { dirname, join, resolve };
