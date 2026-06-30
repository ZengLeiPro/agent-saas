/**
 * Business SQLite — Schema Migrations
 *
 * 极简 migration 框架：
 *   - schema_version 表按 module 维护版本号
 *   - 每个 module 维护自己的 migration 数组
 *   - 启动时自动应用未应用的 migration
 *
 * 添加新 migration 的步骤：
 *   1. 在对应 module 的 migrations 数组末尾追加新版本
 *   2. up() 函数内写 DDL，使用 IF NOT EXISTS 保护
 *   3. 版本号严格递增、不可重用
 */

import type { DatabaseSync } from 'node:sqlite';

import { LEGACY_TENANT_ID } from '../tenants/types.js';

export interface Migration {
  module: string;
  version: number;
  description: string;
  up: (db: DatabaseSync) => void;
}

/**
 * Token usage 模块 migrations。
 */
const TOKEN_USAGE_MIGRATIONS: Migration[] = [
  {
    module: 'token_usage',
    version: 1,
    description: 'create token_usage_daily + rebuild_state',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS token_usage_daily (
          date                   TEXT    NOT NULL,
          username               TEXT    NOT NULL,
          model                  TEXT    NOT NULL,
          channel                TEXT    NOT NULL,
          input_tokens           INTEGER NOT NULL DEFAULT 0,
          output_tokens          INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
          cost_usd_micro         INTEGER NOT NULL DEFAULT 0,
          turn_count             INTEGER NOT NULL DEFAULT 0,
          first_seen_at_ms       INTEGER NOT NULL,
          updated_at_ms          INTEGER NOT NULL,
          PRIMARY KEY (date, username, model, channel)
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tud_date     ON token_usage_daily(date);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tud_username ON token_usage_daily(username, date);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tud_model    ON token_usage_daily(model, date);`);

      db.exec(`
        CREATE TABLE IF NOT EXISTS token_usage_rebuild_state (
          id                  INTEGER PRIMARY KEY CHECK (id = 1),
          last_rebuild_at_ms  INTEGER NOT NULL,
          last_full_scan_ms   INTEGER,
          jsonl_max_mtime_ms  INTEGER NOT NULL DEFAULT 0,
          total_files_scanned INTEGER NOT NULL DEFAULT 0,
          total_rows_built    INTEGER NOT NULL DEFAULT 0
        );
      `);
    },
  },
  {
    module: 'token_usage',
    version: 2,
    description: 'add pricing_version to token_usage_daily (本地价格表追溯)',
    up: (db) => {
      // SQLite ADD COLUMN 必须是 constant default。用空串表示 legacy 老行
      // （legacy 老行的 cost_usd_micro 来自 SDK costUSD，迁移到本地价格表前的遗留数据）
      db.exec(`
        ALTER TABLE token_usage_daily
          ADD COLUMN pricing_version TEXT NOT NULL DEFAULT '';
      `);
    },
  },
  {
    module: 'token_usage',
    version: 3,
    description: 'create token_usage_minutely for minute-level custom ranges',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS token_usage_minutely (
          minute                 TEXT    NOT NULL,
          date                   TEXT    NOT NULL,
          username               TEXT    NOT NULL,
          model                  TEXT    NOT NULL,
          channel                TEXT    NOT NULL,
          input_tokens           INTEGER NOT NULL DEFAULT 0,
          output_tokens          INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
          cost_usd_micro         INTEGER NOT NULL DEFAULT 0,
          turn_count             INTEGER NOT NULL DEFAULT 0,
          first_seen_at_ms       INTEGER NOT NULL,
          updated_at_ms          INTEGER NOT NULL,
          pricing_version        TEXT    NOT NULL DEFAULT '',
          PRIMARY KEY (minute, username, model, channel)
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tum_minute   ON token_usage_minutely(minute);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tum_username ON token_usage_minutely(username, minute);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tum_model    ON token_usage_minutely(model, minute);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tum_date     ON token_usage_minutely(date);`);
    },
  },
  {
    module: 'token_usage',
    version: 4,
    description: 'add tenant_id to token_usage_daily / token_usage_minutely (PR 10 跨组织隔离)',
    up: (db) => {
      // SQLite ADD COLUMN 限制：DEFAULT 必须为常量字面值。历史用量缺 tenant 时回填 LEGACY_TENANT_ID。
      // 新实时写入路径会显式带 tenant_id，不依赖本列默认值。
      // 主键 PRIMARY KEY (date, username, model, channel) 不变：username 全局唯一，
      // 同 (date, username, model, channel) 不会跨组织冲突。
      db.exec(`
        ALTER TABLE token_usage_daily
          ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT_ID}';
      `);
      db.exec(`
        ALTER TABLE token_usage_minutely
          ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '${LEGACY_TENANT_ID}';
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tud_tenant_date ON token_usage_daily(tenant_id, date);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tum_tenant_date ON token_usage_minutely(tenant_id, date);`);

      // Legacy daily rows cannot be reconstructed to exact minutes. Seed them at
      // 00:00 so existing history remains visible in broad custom ranges; a
      // rebuild repopulates this table with exact transcript timestamps.
      db.exec(`
        INSERT OR IGNORE INTO token_usage_minutely
          (minute, date, username, model, channel,
           input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
           cost_usd_micro, turn_count, first_seen_at_ms, updated_at_ms, pricing_version)
        SELECT
          date || 'T00:00', date, username, model, channel,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          cost_usd_micro, turn_count, first_seen_at_ms, updated_at_ms, pricing_version
        FROM token_usage_daily;
      `);
    },
  },
];

const ALL_MIGRATIONS: Migration[] = [
  ...TOKEN_USAGE_MIGRATIONS,
  // 未来其他 module 的 migrations 在此追加
];

/**
 * 应用所有未应用的 migration。
 * 幂等：每次启动调用，已应用的会跳过。
 */
export function runBusinessMigrations(db: DatabaseSync): { applied: Migration[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      module       TEXT    PRIMARY KEY,
      version      INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
  `);

  const getVersion = db.prepare('SELECT version FROM schema_version WHERE module = ?');
  const upsertVersion = db.prepare(
    `INSERT INTO schema_version (module, version, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(module) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
  );

  const applied: Migration[] = [];
  // 按 module 分组，组内按 version 升序
  const byModule = new Map<string, Migration[]>();
  for (const m of ALL_MIGRATIONS) {
    const list = byModule.get(m.module) ?? [];
    list.push(m);
    byModule.set(m.module, list);
  }

  for (const [module, list] of byModule) {
    list.sort((a, b) => a.version - b.version);
    const row = getVersion.get(module) as { version: number } | undefined;
    const current = row?.version ?? 0;
    for (const m of list) {
      if (m.version <= current) continue;
      m.up(db);
      upsertVersion.run(m.module, m.version, Date.now());
      applied.push(m);
    }
  }

  return { applied };
}
