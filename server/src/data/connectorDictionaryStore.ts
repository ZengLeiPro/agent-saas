/**
 * 连接器映射词典的持久化（2026-08-03）。
 *
 * 存在理由：`dws` / `lark` 这类连接器 CLI 会自己迭代——加子命令、改动词。
 * 词典硬编码在代码里意味着每次 CLI 升级都要发一次版；把它放进 PG 之后，
 * 运营在平台管理里改完保存即热更新。
 *
 * ## 表结构惯例
 *
 * 与 `runtimeSchedulerConfigStore` / `PgDwsConnectionStore` 同一套：raw `pg` +
 * `CREATE TABLE IF NOT EXISTS` 放在 `init()` 里、外面套 advisory lock，随
 * server 启动执行（**部署链就是迁移链**，不存在需要人手跑的 migration 脚本）。
 *
 * 列名是 `binary_name` 而不是 `binary`：`BINARY` 是 PG 保留字，裸用直接
 * syntax error（2026-08-03 生产实测建表失败、静默回落内置种子）。TS 接口
 * 仍叫 `binary`，只在 SQL/Row 边界换名。
 *
 * ## tenantId 为什么现在就留着
 *
 * 租户级覆盖是可预见的下一步（不同客户装的连接器不同），但本版 UI 与查询
 * 只走平台级（`tenant_id IS NULL`）。字段先留出来的成本是一列 + 一个索引，
 * 后补的成本是一次带数据的表结构变更——两者不对称。
 *
 * ## 刻意不做：草稿 / 不可变版本
 *
 * `agentProfiles` 那套 draft + publish + version 是为「AI 提案 → 人工审批」
 * 准备的。词典改错的爆炸半径是「摘要标题不好看」，不是「线上行为变了」，
 * 上那套机制属于过度设计。改动留审计即可。
 */

import type pg from 'pg';

import {
  cloneBuiltinConnectorDictionary,
  type ConnectorActionVerb,
  type ConnectorDictionaryEntry,
} from '../agent/connectorDictionary.js';

type PgPool = pg.Pool;

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid PG table prefix: ${value}`);
  }
  return value;
}

export interface ConnectorDictionaryRecord extends ConnectorDictionaryEntry {
  updatedAt?: string;
  updatedBy?: string;
}

export interface ConnectorDictionaryStore {
  init(): Promise<void>;
  /** 平台级词典（tenant_id IS NULL），按 binary 排序 */
  listPlatform(): Promise<ConnectorDictionaryRecord[]>;
  /** 整条 upsert；binary 是平台级的天然主键 */
  upsert(entry: ConnectorDictionaryEntry, actor: string): Promise<ConnectorDictionaryRecord>;
  /** 删除一条；返回是否真的删掉了 */
  remove(binary: string, actor: string): Promise<boolean>;
  /** 重置为内置词典（删光平台级行后重新播种） */
  resetToBuiltin(actor: string): Promise<ConnectorDictionaryRecord[]>;
  /** 某租户的覆盖条目（tenant_id = $1），按 binary 排序。2026-08-04 任务 E。 */
  listTenant(tenantId: string): Promise<ConnectorDictionaryRecord[]>;
  /** 租户覆盖整条 upsert；(tenant_id, binary) 唯一 */
  upsertTenant(tenantId: string, entry: ConnectorDictionaryEntry, actor: string): Promise<ConnectorDictionaryRecord>;
  /** 移除某租户的一条覆盖（回落平台条目）；返回是否真的删掉了 */
  removeTenant(tenantId: string, binary: string, actor: string): Promise<boolean>;
  /** 全部租户的覆盖条目（runtime 60s 刷新用），tenantId → entries */
  listAllTenantOverrides(): Promise<Record<string, ConnectorDictionaryRecord[]>>;
}

interface Row {
  binary_name: string;
  system_name: string;
  enabled: boolean;
  modules: unknown;
  action_verbs: unknown;
  exclude_patterns: unknown;
  url_whitelist: unknown;
  updated_at: Date | string | null;
  updated_by: string | null;
}

const MAX_BINARY_LENGTH = 64;
const MAX_NAME_LENGTH = 64;
const MAX_ENTRIES_PER_MAP = 400;
const MAX_LIST_LENGTH = 100;

/** binary 会参与命令行 basename 比较，形状必须收死：不许路径分隔符与空白 */
export function assertConnectorBinary(binary: unknown): string {
  if (typeof binary !== 'string') throw new Error('binary 必须是字符串');
  const trimmed = binary.trim();
  if (!trimmed) throw new Error('binary 不能为空');
  if (trimmed.length > MAX_BINARY_LENGTH) throw new Error(`binary 超过 ${MAX_BINARY_LENGTH} 字符`);
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) throw new Error('binary 只能包含字母、数字、点、下划线与连字符');
  return trimmed;
}

/** tenant slug 形状与 runtime 目录扫描同一约束（小写字母开头，字母数字连字符） */
export function assertConnectorTenantId(tenantId: unknown): string {
  if (typeof tenantId !== 'string' || !tenantId.trim()) throw new Error('tenantId 不能为空');
  const trimmed = tenantId.trim();
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(trimmed)) throw new Error('tenantId 形状非法');
  return trimmed;
}

function normalizeName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`);
  const trimmed = value.trim();
  if (trimmed.length > MAX_NAME_LENGTH) throw new Error(`${label} 超过 ${MAX_NAME_LENGTH} 字符`);
  return trimmed;
}

function normalizeStringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是键值对象`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ENTRIES_PER_MAP) throw new Error(`${label} 最多 ${MAX_ENTRIES_PER_MAP} 项`);
  const result: Record<string, string> = {};
  for (const [key, raw] of entries) {
    const token = key.trim();
    if (!token) continue;
    result[token] = normalizeName(raw, `${label}.${token}`);
  }
  return result;
}

function normalizeActionVerbs(value: unknown): Record<string, ConnectorActionVerb> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('actionVerbs 必须是键值对象');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ENTRIES_PER_MAP) throw new Error(`actionVerbs 最多 ${MAX_ENTRIES_PER_MAP} 项`);
  const result: Record<string, ConnectorActionVerb> = {};
  for (const [key, raw] of entries) {
    const token = key.trim();
    if (!token) continue;
    if (!raw || typeof raw !== 'object') throw new Error(`actionVerbs.${token} 必须是 {name, write}`);
    const item = raw as Record<string, unknown>;
    // write 必须显式给：读写分档决定要不要盖回执章，默认成任意一边都会造假事实
    if (typeof item.write !== 'boolean') throw new Error(`actionVerbs.${token}.write 必须是布尔`);
    result[token] = { name: normalizeName(item.name, `actionVerbs.${token}.name`), write: item.write };
  }
  return result;
}

function normalizeStringList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  if (value.length > MAX_LIST_LENGTH) throw new Error(`${label} 最多 ${MAX_LIST_LENGTH} 项`);
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${label} 只能是字符串`);
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_NAME_LENGTH) throw new Error(`${label} 单项超过 ${MAX_NAME_LENGTH} 字符`);
    seen.add(trimmed);
  }
  return [...seen];
}

/**
 * 校验并归一化一条词典条目。
 *
 * 这层不是「防手滑」，是**防造假事实**：`write` 缺省会让读操作盖上回执章，
 * urlWhitelist 里塞个 `*` 会让任意域名的链接被当成业务链接透出。
 */
export function normalizeConnectorEntry(raw: unknown): ConnectorDictionaryEntry {
  if (!raw || typeof raw !== 'object') throw new Error('连接器条目必须是对象');
  const input = raw as Record<string, unknown>;
  const urlWhitelist = normalizeStringList(input.urlWhitelist, 'urlWhitelist');
  for (const pattern of urlWhitelist) {
    // `*` / `*.` 这类全通配等于没有白名单——生产 34% 的含 URL 输出是噪声域名
    const host = pattern.startsWith('*.') ? pattern.slice(2) : pattern;
    if (!host || host.includes('*') || !/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(host)) {
      throw new Error(`urlWhitelist 项非法：${pattern}（只接受 example.com 或 *.example.com）`);
    }
  }
  return {
    binary: assertConnectorBinary(input.binary),
    systemName: normalizeName(input.systemName, 'systemName'),
    enabled: input.enabled !== false,
    modules: normalizeStringMap(input.modules, 'modules'),
    actionVerbs: normalizeActionVerbs(input.actionVerbs),
    excludePatterns: normalizeStringList(input.excludePatterns, 'excludePatterns'),
    urlWhitelist,
  };
}

function rowToRecord(row: Row): ConnectorDictionaryRecord {
  return {
    binary: row.binary_name,
    systemName: row.system_name,
    enabled: row.enabled,
    modules: (row.modules ?? {}) as Record<string, string>,
    actionVerbs: (row.action_verbs ?? {}) as Record<string, ConnectorActionVerb>,
    excludePatterns: (row.exclude_patterns ?? []) as string[],
    urlWhitelist: (row.url_whitelist ?? []) as string[],
    ...(row.updated_at ? { updatedAt: new Date(row.updated_at).toISOString() } : {}),
    ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
  };
}

export class PgConnectorDictionaryStore implements ConnectorDictionaryStore {
  readonly table: string;

  constructor(
    private readonly pool: PgPool,
    options: { tablePrefix?: string } = {},
  ) {
    this.table = `${sanitizeIdentifier(options.tablePrefix ?? 'runtime')}_connector_dictionary`;
  }

  async init(): Promise<void> {
    const lockKey = `${this.table}:init`;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table} (
          id BIGSERIAL PRIMARY KEY,
          tenant_id TEXT,
          binary_name TEXT NOT NULL,
          system_name TEXT NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          modules JSONB NOT NULL DEFAULT '{}'::jsonb,
          action_verbs JSONB NOT NULL DEFAULT '{}'::jsonb,
          exclude_patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
          url_whitelist JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by TEXT
        )
      `);
      // 平台级与租户级各自唯一：PG 的唯一索引把多个 NULL 视为互不相等，
      // 所以平台级必须用 partial index 才能真的挡住重复 binary
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${this.table}_platform_binary_uniq
         ON ${this.table} (binary_name) WHERE tenant_id IS NULL`,
      );
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${this.table}_tenant_binary_uniq
         ON ${this.table} (tenant_id, binary_name) WHERE tenant_id IS NOT NULL`,
      );
      await this.seedBuiltin(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  /**
   * 播种内置词典。ON CONFLICT DO NOTHING——已被运营改过的条目不得被启动覆盖，
   * 这是「配置优先于代码」的物理保证。
   */
  private async seedBuiltin(client: pg.PoolClient): Promise<void> {
    for (const entry of cloneBuiltinConnectorDictionary()) {
      await client.query(
        `INSERT INTO ${this.table}
           (tenant_id, binary_name, system_name, enabled, modules, action_verbs, exclude_patterns, url_whitelist, updated_by)
         VALUES (NULL, $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, 'bootstrap')
         ON CONFLICT (binary_name) WHERE tenant_id IS NULL DO NOTHING`,
        [
          entry.binary,
          entry.systemName,
          entry.enabled,
          JSON.stringify(entry.modules),
          JSON.stringify(entry.actionVerbs),
          JSON.stringify(entry.excludePatterns),
          JSON.stringify(entry.urlWhitelist),
        ],
      );
    }
  }

  async listPlatform(): Promise<ConnectorDictionaryRecord[]> {
    const result = await this.pool.query<Row>(
      `SELECT binary_name, system_name, enabled, modules, action_verbs, exclude_patterns, url_whitelist, updated_at, updated_by
       FROM ${this.table}
       WHERE tenant_id IS NULL
       ORDER BY binary_name ASC`,
    );
    return result.rows.map(rowToRecord);
  }

  async upsert(entry: ConnectorDictionaryEntry, actor: string): Promise<ConnectorDictionaryRecord> {
    const result = await this.pool.query<Row>(
      `INSERT INTO ${this.table}
         (tenant_id, binary_name, system_name, enabled, modules, action_verbs, exclude_patterns, url_whitelist, updated_at, updated_by)
       VALUES (NULL, $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, NOW(), $8)
       ON CONFLICT (binary_name) WHERE tenant_id IS NULL DO UPDATE SET
         system_name = EXCLUDED.system_name,
         enabled = EXCLUDED.enabled,
         modules = EXCLUDED.modules,
         action_verbs = EXCLUDED.action_verbs,
         exclude_patterns = EXCLUDED.exclude_patterns,
         url_whitelist = EXCLUDED.url_whitelist,
         updated_at = NOW(),
         updated_by = EXCLUDED.updated_by
       RETURNING binary_name, system_name, enabled, modules, action_verbs, exclude_patterns, url_whitelist, updated_at, updated_by`,
      [
        entry.binary,
        entry.systemName,
        entry.enabled,
        JSON.stringify(entry.modules),
        JSON.stringify(entry.actionVerbs),
        JSON.stringify(entry.excludePatterns),
        JSON.stringify(entry.urlWhitelist),
        actor,
      ],
    );
    return rowToRecord(result.rows[0]!);
  }

  async remove(binary: string, _actor: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM ${this.table} WHERE tenant_id IS NULL AND binary_name = $1`,
      [assertConnectorBinary(binary)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async resetToBuiltin(_actor: string): Promise<ConnectorDictionaryRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM ${this.table} WHERE tenant_id IS NULL`);
      await this.seedBuiltin(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return this.listPlatform();
  }

  async listTenant(tenantId: string): Promise<ConnectorDictionaryRecord[]> {
    const result = await this.pool.query<Row>(
      `SELECT binary_name, system_name, enabled, modules, action_verbs, exclude_patterns, url_whitelist, updated_at, updated_by
       FROM ${this.table}
       WHERE tenant_id = $1
       ORDER BY binary_name ASC`,
      [assertConnectorTenantId(tenantId)],
    );
    return result.rows.map(rowToRecord);
  }

  async upsertTenant(
    tenantId: string,
    entry: ConnectorDictionaryEntry,
    actor: string,
  ): Promise<ConnectorDictionaryRecord> {
    const result = await this.pool.query<Row>(
      `INSERT INTO ${this.table}
         (tenant_id, binary_name, system_name, enabled, modules, action_verbs, exclude_patterns, url_whitelist, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, NOW(), $9)
       ON CONFLICT (tenant_id, binary_name) WHERE tenant_id IS NOT NULL DO UPDATE SET
         system_name = EXCLUDED.system_name,
         enabled = EXCLUDED.enabled,
         modules = EXCLUDED.modules,
         action_verbs = EXCLUDED.action_verbs,
         exclude_patterns = EXCLUDED.exclude_patterns,
         url_whitelist = EXCLUDED.url_whitelist,
         updated_at = NOW(),
         updated_by = EXCLUDED.updated_by
       RETURNING binary_name, system_name, enabled, modules, action_verbs, exclude_patterns, url_whitelist, updated_at, updated_by`,
      [
        assertConnectorTenantId(tenantId),
        entry.binary,
        entry.systemName,
        entry.enabled,
        JSON.stringify(entry.modules),
        JSON.stringify(entry.actionVerbs),
        JSON.stringify(entry.excludePatterns),
        JSON.stringify(entry.urlWhitelist),
        actor,
      ],
    );
    return rowToRecord(result.rows[0]!);
  }

  async removeTenant(tenantId: string, binary: string, _actor: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM ${this.table} WHERE tenant_id = $1 AND binary_name = $2`,
      [assertConnectorTenantId(tenantId), assertConnectorBinary(binary)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listAllTenantOverrides(): Promise<Record<string, ConnectorDictionaryRecord[]>> {
    const result = await this.pool.query<Row & { tenant_id: string }>(
      `SELECT tenant_id, binary_name, system_name, enabled, modules, action_verbs, exclude_patterns, url_whitelist, updated_at, updated_by
       FROM ${this.table}
       WHERE tenant_id IS NOT NULL
       ORDER BY tenant_id ASC, binary_name ASC`,
    );
    const grouped: Record<string, ConnectorDictionaryRecord[]> = {};
    for (const row of result.rows) {
      (grouped[row.tenant_id] ??= []).push(rowToRecord(row));
    }
    return grouped;
  }
}

/**
 * 无 PG 部署（文件事件存储 / 单测）时的内存实现。
 *
 * 行为与 PG 版一致，只是重启即丢——这条路上的部署本来就没有持久化诉求，
 * 但 admin 页与热更新链路必须能跑通，否则「无 PG」会变成一条没人测过的路径。
 */
export class InMemoryConnectorDictionaryStore implements ConnectorDictionaryStore {
  private entries = new Map<string, ConnectorDictionaryRecord>();
  /** tenantId → (binary → record) */
  private tenantEntries = new Map<string, Map<string, ConnectorDictionaryRecord>>();

  async init(): Promise<void> {
    if (this.entries.size > 0) return;
    for (const entry of cloneBuiltinConnectorDictionary()) {
      this.entries.set(entry.binary, { ...entry, updatedBy: 'bootstrap' });
    }
  }

  async listPlatform(): Promise<ConnectorDictionaryRecord[]> {
    return [...this.entries.values()]
      .map((entry) => JSON.parse(JSON.stringify(entry)) as ConnectorDictionaryRecord)
      .sort((a, b) => a.binary.localeCompare(b.binary));
  }

  async upsert(entry: ConnectorDictionaryEntry, actor: string): Promise<ConnectorDictionaryRecord> {
    const record: ConnectorDictionaryRecord = {
      ...JSON.parse(JSON.stringify(entry)) as ConnectorDictionaryEntry,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    };
    this.entries.set(entry.binary, record);
    return record;
  }

  async remove(binary: string, _actor: string): Promise<boolean> {
    return this.entries.delete(assertConnectorBinary(binary));
  }

  async resetToBuiltin(_actor: string): Promise<ConnectorDictionaryRecord[]> {
    this.entries.clear();
    await this.init();
    return this.listPlatform();
  }

  async listTenant(tenantId: string): Promise<ConnectorDictionaryRecord[]> {
    const bucket = this.tenantEntries.get(assertConnectorTenantId(tenantId));
    if (!bucket) return [];
    return [...bucket.values()]
      .map((entry) => JSON.parse(JSON.stringify(entry)) as ConnectorDictionaryRecord)
      .sort((a, b) => a.binary.localeCompare(b.binary));
  }

  async upsertTenant(
    tenantId: string,
    entry: ConnectorDictionaryEntry,
    actor: string,
  ): Promise<ConnectorDictionaryRecord> {
    const key = assertConnectorTenantId(tenantId);
    const record: ConnectorDictionaryRecord = {
      ...JSON.parse(JSON.stringify(entry)) as ConnectorDictionaryEntry,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    };
    const bucket = this.tenantEntries.get(key) ?? new Map<string, ConnectorDictionaryRecord>();
    bucket.set(entry.binary, record);
    this.tenantEntries.set(key, bucket);
    return record;
  }

  async removeTenant(tenantId: string, binary: string, _actor: string): Promise<boolean> {
    const bucket = this.tenantEntries.get(assertConnectorTenantId(tenantId));
    if (!bucket) return false;
    return bucket.delete(assertConnectorBinary(binary));
  }

  async listAllTenantOverrides(): Promise<Record<string, ConnectorDictionaryRecord[]>> {
    const grouped: Record<string, ConnectorDictionaryRecord[]> = {};
    for (const [tenantId] of this.tenantEntries) {
      const list = await this.listTenant(tenantId);
      if (list.length) grouped[tenantId] = list;
    }
    return grouped;
  }
}
