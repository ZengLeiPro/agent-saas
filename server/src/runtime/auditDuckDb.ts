/**
 * Audit DuckDB 单进程句柄（singleton）。
 *
 * 与 `business.sqlite` 物理隔离：
 *   - business.sqlite → 业务事务（token 用量等）
 *   - audit.duckdb    → runtime tool_audit 投影
 *
 * 默认路径：`<dataDir>/audit.duckdb`。
 *
 * 首次调用 `getAuditDuckDb(dataDir)` 时 create + connect；后续调用复用。
 * shutdown 路径调 `closeAuditDuckDb()` 释放句柄。
 *
 * 注：DuckDBInstance.create 是 async，工厂签名与 `getBusinessDb` 的同步 API
 * 不同；调用方必须 await。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

export interface AuditDuckDbHandle {
  instance: DuckDBInstance;
  db: DuckDBConnection;
  dbPath: string;
}

let _handle: AuditDuckDbHandle | null = null;
let _initPromise: Promise<AuditDuckDbHandle> | null = null;

/**
 * 获取/创建 audit DuckDB 单例。多个并发 caller 共享同一 init Promise。
 */
export async function getAuditDuckDb(dataDir: string): Promise<AuditDuckDbHandle> {
  if (_handle) return _handle;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const dbDir = resolve(dataDir);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    const dbPath = join(dbDir, 'audit.duckdb');
    const instance = await DuckDBInstance.create(dbPath);
    const db = await instance.connect();
    _handle = { instance, db, dbPath };
    return _handle;
  })();

  try {
    return await _initPromise;
  } finally {
    // init Promise 不再被需要（成功或失败都清掉，失败下次重试）
    if (!_handle) _initPromise = null;
  }
}

export function getAuditDuckDbPath(): string | null {
  return _handle?.dbPath ?? null;
}

export async function closeAuditDuckDb(): Promise<void> {
  if (!_handle) return;
  const { instance, db } = _handle;
  try { db.closeSync(); } catch { /* ignore */ }
  try { instance.closeSync(); } catch { /* ignore */ }
  _handle = null;
  _initPromise = null;
}

/** 内部测试用：允许测试重置单例（不 close 真实句柄）。 */
export function __resetAuditDuckDbForTest(): void {
  _handle = null;
  _initPromise = null;
}
