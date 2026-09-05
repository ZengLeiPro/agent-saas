/**
 * §3.1-6 `jti` 的 PostgreSQL 实现：唯一约束 + `INSERT ... ON CONFLICT DO NOTHING`，
 * 跨进程原子。表结构见 `sql/001_ky_app_server.sql`（expand-only）。
 *
 * 本文件刻意只用 `import type` 引兄弟模块，运行时不依赖包内其他源文件，
 * 便于双进程测试用 Node 的类型擦除直接 fork 加载。
 */
import type { Pool } from 'pg';

import type { JtiStore } from './jtiStore.js';

export const JTI_TABLE = 'ky_app_jti';

/** 建表语句（expand-only，可重复执行）。 */
export const JTI_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS ${JTI_TABLE} (
  jti        TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${JTI_TABLE}_expires_at_idx ON ${JTI_TABLE} (expires_at);
`;

export interface PgJtiStoreOptions {
  /** 每隔多少毫秒顺带清理一次过期行；<= 0 表示不自动清理。 */
  purgeIntervalMs?: number;
  now?: () => number;
}

export class PgJtiStore implements JtiStore {
  private lastPurgeAt = 0;
  private readonly purgeIntervalMs: number;
  private readonly now: () => number;

  constructor(
    private readonly pool: Pool,
    options: PgJtiStoreOptions = {},
  ) {
    this.purgeIntervalMs = options.purgeIntervalMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  /** 建表；生产环境应走迁移脚本，这里供 doctor 与测试使用。 */
  async ensureSchema(): Promise<void> {
    await this.pool.query(JTI_TABLE_DDL);
  }

  async consume(jti: string, expiresAt: Date): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO ${JTI_TABLE} (jti, expires_at) VALUES ($1, $2)
       ON CONFLICT (jti) DO NOTHING
       RETURNING jti`,
      [jti, expiresAt],
    );
    const inserted = result.rowCount === 1;
    await this.maybePurge();
    return inserted;
  }

  /** 删除过期占用；返回删除行数。 */
  async purgeExpired(): Promise<number> {
    const result = await this.pool.query(`DELETE FROM ${JTI_TABLE} WHERE expires_at <= now()`);
    return result.rowCount ?? 0;
  }

  private async maybePurge(): Promise<void> {
    if (this.purgeIntervalMs <= 0) return;
    const current = this.now();
    if (current - this.lastPurgeAt < this.purgeIntervalMs) return;
    this.lastPurgeAt = current;
    try {
      await this.purgeExpired();
    } catch {
      // 清理失败不影响主流程：过期行只是占空间，判定仍然 fail-closed。
    }
  }
}
