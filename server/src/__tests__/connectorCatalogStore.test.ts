import { describe, expect, it } from 'vitest';

import { BUILTIN_CONNECTOR_DEFINITIONS, PgConnectorCatalogStore } from '../data/connectorCatalog/index.js';

const NOW = '2026-08-08T00:00:00.000Z';

function definitionRow(overrides: Record<string, unknown> = {}) {
  return {
    connector_id: 'github',
    name: 'GitHub',
    status: 'draft',
    current_version_id: null,
    auth_methods_json: [],
    capability_schema_json: {},
    version: '1',
    created_at: NOW,
    created_by: 'system',
    updated_at: NOW,
    updated_by: 'system',
    ...overrides,
  };
}

function buildPool() {
  const definitions = new Map<string, Record<string, unknown>>();
  const versions: Record<string, unknown>[] = [];
  const queries: string[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push(sql);
    if (sql.includes('SELECT version FROM')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO test_connector_definitions')) {
      definitions.set(String(params[0]), definitionRow({
        connector_id: params[0], name: params[1], auth_methods_json: JSON.parse(String(params[2])),
        capability_schema_json: JSON.parse(String(params[3])), created_by: params[4], updated_by: params[4],
      }));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM test_connector_definitions') && sql.includes('WHERE connector_id = $1')) {
      const row = definitions.get(String(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM test_connector_definition_versions') && sql.includes('digest = $2')) {
      const row = versions.find(item => item.connector_id === params[0] && item.digest === params[1]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('MAX(version_number)')) {
      const max = versions.filter(item => item.connector_id === params[0])
        .reduce((value, item) => Math.max(value, Number(item.version_number)), 0);
      return { rows: [{ next_version: String(max + 1) }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO test_connector_definition_versions') && sql.includes('RETURNING')) {
      const row = {
        version_id: params[0], connector_id: params[1], version_number: String(params[2]),
        definition_json: JSON.parse(String(params[3])), digest: params[4], published_at: NOW, published_by: params[5],
      };
      versions.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_connector_definitions') && sql.includes("status = 'published'")) {
      const current = definitions.get(String(params[0]))!;
      const updated = {
        ...current,
        name: params[1], status: 'published', current_version_id: params[2],
        auth_methods_json: JSON.parse(String(params[3])), capability_schema_json: JSON.parse(String(params[4])),
        version: String(Number(current.version) + 1), updated_by: params[5],
      };
      definitions.set(String(params[0]), updated);
      return { rows: [updated], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_connector_definitions') && sql.includes('status = $2')) {
      const current = definitions.get(String(params[0]));
      if (!current || Number(current.version) !== Number(params[3])) return { rows: [], rowCount: 0 };
      const updated = { ...current, status: params[1], version: String(Number(current.version) + 1), updated_by: params[2] };
      definitions.set(String(params[0]), updated);
      return { rows: [updated], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM test_connector_definition_versions WHERE version_id = $1')) {
      const row = versions.find(item => item.version_id === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('SELECT * FROM test_connector_definitions ORDER BY')) {
      return { rows: [...definitions.values()], rowCount: definitions.size };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { pool: pool as never, queries, definitions, versions };
}

const githubInput = {
  connectorId: 'github',
  name: 'GitHub',
  authMethods: ['oauth', 'personal_access_token'],
  capabilitySchema: { repository: ['read'] },
  definition: { provider: 'github', transport: 'server_proxy' },
  publishedBy: 'platform-admin',
};

describe('Connector Catalog', () => {
  it('migration V7 创建 Definition/immutable Version 表，不复用展示词典', async () => {
    const { pool, queries } = buildPool();
    const store = new PgConnectorCatalogStore({ pool, tablePrefix: 'test' });
    await store.init();
    const sql = queries.join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_connector_definitions');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_connector_definition_versions');
    expect(sql).toContain("status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'disabled', 'retired'))");
    expect(sql).toContain('UNIQUE (connector_id, version_number)');
    expect(queries.filter(item => item === 'BEGIN')).toHaveLength(33);
  });

  it('publish 创建 immutable version、digest 与 currentVersionId', async () => {
    const { pool, versions } = buildPool();
    const store = new PgConnectorCatalogStore({ pool, tablePrefix: 'test' });
    const result = await store.publish(githubInput);
    expect(result.created).toBe(true);
    expect(result.definition).toMatchObject({ connectorId: 'github', status: 'published', version: 2 });
    expect(result.publishedVersion).toMatchObject({ connectorId: 'github', versionNumber: 1 });
    expect(result.publishedVersion.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.definition.currentVersionId).toBe(result.publishedVersion.versionId);
    expect(versions).toHaveLength(1);
  });

  it('相同内容重复 publish 幂等，不新增 version', async () => {
    const { pool, versions } = buildPool();
    const store = new PgConnectorCatalogStore({ pool, tablePrefix: 'test' });
    const first = await store.publish(githubInput);
    const second = await store.publish(githubInput);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.publishedVersion.versionId).toBe(first.publishedVersion.versionId);
    expect(versions).toHaveLength(1);
  });

  it('内容变化发布 versionNumber+1，历史版本不更新', async () => {
    const { pool, versions } = buildPool();
    const store = new PgConnectorCatalogStore({ pool, tablePrefix: 'test' });
    await store.publish(githubInput);
    const second = await store.publish({ ...githubInput, capabilitySchema: { repository: ['read', 'write'] } });
    expect(second.publishedVersion.versionNumber).toBe(2);
    expect(versions).toHaveLength(2);
    expect(versions[0].definition_json).toMatchObject({ capabilitySchema: { repository: ['read'] } });
  });

  it('disabled/retired 状态写使用 expectedVersion；retired 不可重新发布', async () => {
    const { pool } = buildPool();
    const store = new PgConnectorCatalogStore({ pool, tablePrefix: 'test' });
    const published = await store.publish(githubInput);
    await expect(store.updateStatus('github', 'disabled', 99, 'admin'))
      .rejects.toMatchObject({ code: 'CONNECTOR_VERSION_CONFLICT' });
    const retired = await store.updateStatus('github', 'retired', published.definition.version, 'admin');
    expect(retired.status).toBe('retired');
    await expect(store.publish(githubInput)).rejects.toMatchObject({ code: 'CONNECTOR_RETIRED' });
  });

  it('builtin 启动回填不重新启用运维显式 disabled/retired 的定义', async () => {
    const { pool, definitions } = buildPool();
    definitions.set('github', definitionRow({ connector_id: 'github', status: 'disabled', version: '4' }));
    const store = new PgConnectorCatalogStore({ pool, tablePrefix: 'test' });
    const result = await store.ensureBuiltins('system:builtin-catalog');
    expect(result).toEqual({ created: 6, unchanged: 1 });
    expect(definitions.get('github')).toMatchObject({ status: 'disabled', version: '4' });
  });

  it('builtin 注册表覆盖当前七个集成且不含 Secret', () => {
    expect(BUILTIN_CONNECTOR_DEFINITIONS.map(item => item.connectorId).sort()).toEqual([
      'aliyun', 'dws', 'feishu', 'github', 'google_workspace', 'notion', 'x',
    ]);
    expect(JSON.stringify(BUILTIN_CONNECTOR_DEFINITIONS).toLowerCase()).not.toContain('secret');
    expect(JSON.stringify(BUILTIN_CONNECTOR_DEFINITIONS).toLowerCase()).not.toContain('tokenvalue');
  });

  it('非法 connectorId/name/auth method fail closed', async () => {
    const { pool } = buildPool();
    const store = new PgConnectorCatalogStore({ pool, tablePrefix: 'test' });
    await expect(store.publish({ ...githubInput, connectorId: 'GitHub!' }))
      .rejects.toMatchObject({ code: 'CONNECTOR_DEFINITION_INVALID' });
    await expect(store.publish({ ...githubInput, name: ' ' }))
      .rejects.toMatchObject({ code: 'CONNECTOR_DEFINITION_INVALID' });
    await expect(store.publish({ ...githubInput, authMethods: [''] }))
      .rejects.toMatchObject({ code: 'CONNECTOR_DEFINITION_INVALID' });
    await expect(store.publish({ ...githubInput, definition: { apiKey: 'plain-secret' } }))
      .rejects.toMatchObject({ code: 'CONNECTOR_DEFINITION_SENSITIVE' });
    await expect(store.publish({ ...githubInput, definition: { setup: 'Authorization: Bearer sensitive-value' } }))
      .rejects.toMatchObject({ code: 'CONNECTOR_DEFINITION_SENSITIVE' });
  });
});
