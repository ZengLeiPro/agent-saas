import { describe, expect, it } from 'vitest';

import { PgAgentResourceStore, assertManagedAgentDefinitionSafe } from '../data/agentResources/index.js';

const NOW = '2026-08-08T00:00:00.000Z';

function resourceRow(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: 'oa-1', tenant_id: 'acme', kind: 'org_agent', owner_user_id: 'user-owner',
    template_id: null, status: 'draft', current_version_id: null, revision: '1',
    created_at: NOW, created_by: 'owner', updated_at: NOW, updated_by: 'owner',
    archived_at: null, archived_by: null, ...overrides,
  };
}

function buildPool() {
  const resources = new Map<string, Record<string, unknown>>();
  const versions: Record<string, unknown>[] = [];
  const queries: string[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push(sql);
    if (sql.includes('SELECT version FROM')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO test_managed_agents') && sql.includes('RETURNING')) {
      if (resources.has(String(params[0]))) return { rows: [], rowCount: 0 };
      const row = resourceRow({
        agent_id: params[0], tenant_id: params[1], kind: params[2], owner_user_id: params[3],
        template_id: params[4], created_by: params[5], updated_by: params[5],
      });
      resources.set(String(params[0]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('FROM test_managed_agents') && /agent_id\s*=\s*\$[12]/.test(sql)) {
      const idIndex = sql.includes('tenant_id=$1') ? 1 : 0;
      const row = resources.get(String(params[idIndex]));
      const visible = row && (!sql.includes('tenant_id=$1') || row.tenant_id === params[0]) ? row : undefined;
      return { rows: visible ? [visible] : [], rowCount: visible ? 1 : 0 };
    }
    if (sql.includes('FROM test_managed_agent_versions') && sql.includes('digest=$2')) {
      const row = versions.find(item => item.agent_id === params[0] && item.digest === params[1]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('MAX(version_number)')) {
      const max = versions.filter(item => item.agent_id === params[0]).reduce((n, item) => Math.max(n, Number(item.version_number)), 0);
      return { rows: [{ next_version: String(max + 1) }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO test_managed_agent_versions') && sql.includes('RETURNING')) {
      const row = {
        version_id: params[0], agent_id: params[1], version_number: String(params[2]),
        definition_json: JSON.parse(String(params[3])), digest: params[4], published_at: NOW, published_by: params[5],
      };
      versions.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_managed_agents') && sql.includes("current_version_id=$2")) {
      const current = resources.get(String(params[0]));
      if (!current || Number(current.revision) !== Number(params[3])) return { rows: [], rowCount: 0 };
      const row = { ...current, status: 'enabled', current_version_id: params[1], revision: String(Number(current.revision) + 1), updated_by: params[2] };
      resources.set(String(params[0]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_managed_agents') && sql.includes("status='archived'")) {
      const current = resources.get(String(params[1]));
      if (!current || current.tenant_id !== params[0] || current.status === 'archived' || Number(current.revision) !== Number(params[2])) return { rows: [], rowCount: 0 };
      const row = { ...current, status: 'archived', revision: String(Number(current.revision) + 1), archived_at: NOW, archived_by: params[3], updated_by: params[3] };
      resources.set(String(params[1]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_managed_agents') && sql.includes('SET status=$3')) {
      const current = resources.get(String(params[1]));
      if (!current || current.tenant_id !== params[0] || current.status === 'archived' || current.status === 'draft' || Number(current.revision) !== Number(params[4])) return { rows: [], rowCount: 0 };
      const row = { ...current, status: params[2], revision: String(Number(current.revision) + 1), updated_by: params[3] };
      resources.set(String(params[1]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('FROM test_managed_agent_versions WHERE version_id=$1')) {
      const row = versions.find(item => item.version_id === params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { pool: pool as never, resources, versions, queries };
}

const definition = {
  name: '销售助理', instructions: '只回答销售流程问题', skillVersionIds: ['skillv-1'],
  audienceAssignmentSetId: 'assign-1', memoryPolicy: 'personal',
};

describe('Typed Agent Resource', () => {
  it('migration V9 创建 stable Agent 与 immutable Version 表并跑完当前 ledger', async () => {
    const { pool, queries } = buildPool();
    const store = new PgAgentResourceStore({ pool, tablePrefix: 'test' });
    await store.init();
    const sql = queries.join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_managed_agents');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_managed_agent_versions');
    expect(sql).toContain("kind IN ('org_agent', 'personal_agent', 'agent_template')");
    expect(sql).toContain("status IN ('draft', 'enabled', 'disabled', 'archived')");
    expect(queries.filter(item => item === 'BEGIN')).toHaveLength(34);
  });

  it.each(['org_agent', 'personal_agent', 'agent_template'] as const)('%s 创建时保存 immutable owner', async kind => {
    const { pool } = buildPool();
    const store = new PgAgentResourceStore({ pool, tablePrefix: 'test' });
    const created = await store.create({
      agentId: `${kind}-1`, tenantId: 'acme', kind, ownerUserId: 'user-owner', createdBy: 'admin',
    });
    expect(created).toMatchObject({ kind, ownerUserId: 'user-owner', status: 'draft', revision: 1 });
  });

  it('发布 immutable version，digest 幂等，revision 乐观锁', async () => {
    const { pool, versions } = buildPool();
    const store = new PgAgentResourceStore({ pool, tablePrefix: 'test' });
    await store.create({ agentId: 'oa-1', tenantId: 'acme', kind: 'org_agent', ownerUserId: 'user-owner', createdBy: 'admin' });
    const first = await store.publishVersion({ tenantId: 'acme', agentId: 'oa-1', expectedRevision: 1, definition, publishedBy: 'admin' });
    const duplicate = await store.publishVersion({ tenantId: 'acme', agentId: 'oa-1', expectedRevision: 2, definition, publishedBy: 'admin' });
    expect(first.resource).toMatchObject({ status: 'enabled', revision: 2 });
    expect(first.version.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(duplicate.created).toBe(false);
    expect(versions).toHaveLength(1);
    await expect(store.publishVersion({
      tenantId: 'acme', agentId: 'oa-1', expectedRevision: 1, definition: { ...definition, name: '新版' }, publishedBy: 'admin',
    })).rejects.toMatchObject({ code: 'AGENT_RESOURCE_VERSION_CONFLICT' });
  });

  it('恢复历史 digest 时重新切换 current version，而不是错误 no-op', async () => {
    const { pool, versions } = buildPool();
    const store = new PgAgentResourceStore({ pool, tablePrefix: 'test' });
    await store.create({ agentId: 'oa-1', tenantId: 'acme', kind: 'org_agent', ownerUserId: 'user-owner', createdBy: 'admin' });
    const first = await store.publishVersion({ tenantId: 'acme', agentId: 'oa-1', expectedRevision: 1, definition, publishedBy: 'admin' });
    await store.publishVersion({
      tenantId: 'acme', agentId: 'oa-1', expectedRevision: 2,
      definition: { ...definition, name: '新版' }, publishedBy: 'admin',
    });
    const reverted = await store.publishVersion({
      tenantId: 'acme', agentId: 'oa-1', expectedRevision: 3, definition, publishedBy: 'admin',
    });
    expect(reverted).toMatchObject({ created: false, changed: true });
    expect(reverted.resource).toMatchObject({ currentVersionId: first.version.versionId, revision: 4 });
    expect(versions).toHaveLength(2);
  });

  it('写操作按 tenant 隔离，draft 不得绕过发布直接 enabled', async () => {
    const { pool } = buildPool();
    const store = new PgAgentResourceStore({ pool, tablePrefix: 'test' });
    await store.create({ agentId: 'oa-1', tenantId: 'acme', kind: 'org_agent', ownerUserId: 'user-owner', createdBy: 'admin' });
    await expect(store.publishVersion({
      tenantId: 'beta', agentId: 'oa-1', expectedRevision: 1, definition, publishedBy: 'beta-admin',
    })).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND' });
    await expect(store.setStatus('acme', 'oa-1', 'enabled', 1, 'admin'))
      .rejects.toMatchObject({ code: 'AGENT_RESOURCE_INVALID_TRANSITION' });
  });

  it('archive 是终态，禁止重新发布与硬删除语义', async () => {
    const { pool } = buildPool();
    const store = new PgAgentResourceStore({ pool, tablePrefix: 'test' });
    await store.create({ agentId: 'oa-1', tenantId: 'acme', kind: 'org_agent', ownerUserId: 'user-owner', createdBy: 'admin' });
    const archived = await store.archive('acme', 'oa-1', 1, 'admin');
    expect(archived).toMatchObject({ status: 'archived', revision: 2, archivedBy: 'admin' });
    await expect(store.publishVersion({ tenantId: 'acme', agentId: 'oa-1', expectedRevision: 2, definition, publishedBy: 'admin' }))
      .rejects.toMatchObject({ code: 'AGENT_RESOURCE_ARCHIVED' });
    await expect(store.setStatus('acme', 'oa-1', 'enabled', 2, 'admin'))
      .rejects.toMatchObject({ code: 'AGENT_RESOURCE_ARCHIVED' });
  });

  it('Agent Definition 禁止 Credential/Secret/消息正文/raw 参数', () => {
    expect(() => assertManagedAgentDefinitionSafe(definition)).not.toThrow();
    for (const invalid of [
      { credentialId: 'cred-1' }, { secretRef: 'ref-1' }, { apiKey: 'key' }, { access_token: 'token' },
      { clientSecret: 'secret' }, { messageBody: '用户正文' }, { rawParams: { q: 1 } },
    ]) {
      expect(() => assertManagedAgentDefinitionSafe(invalid))
        .toThrowError(expect.objectContaining({ code: 'AGENT_DEFINITION_SENSITIVE' }));
    }
  });
});
