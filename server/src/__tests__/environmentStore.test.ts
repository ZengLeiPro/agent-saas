import { describe, expect, it } from 'vitest';

import { PgEnvironmentStore, assertNoSensitiveRecipeFields } from '../data/environments/index.js';

const NOW = '2026-08-08T00:00:00.000Z';

function providerRow(overrides: Record<string, unknown> = {}) {
  return {
    provider_id: 'acs', status: 'enabled', endpoint_ref: 'provider://acs',
    network_policy_json: {}, infrastructure_credential_id: 'cred-infra', rollout_policy_json: {},
    revision: '1', created_at: NOW, created_by: 'system', updated_at: NOW, updated_by: 'system',
    ...overrides,
  };
}

function templateRow(overrides: Record<string, unknown> = {}) {
  return {
    template_id: 'node-default', name: 'Node 默认环境', status: 'draft', current_version_id: null,
    revision: '1', created_at: NOW, created_by: 'system', updated_at: NOW, updated_by: 'system',
    ...overrides,
  };
}

function instanceRow(overrides: Record<string, unknown> = {}) {
  return {
    instance_id: 'instance-1', tenant_id: 'acme', provider_id: 'acs', template_id: 'node-default',
    template_version_id: 'version-1', hand_id: 'hand-1', status: 'provisioning',
    lease_expires_at: '2026-08-08T01:00:00.000Z', revision: '1', recipe_digest: 'digest-1',
    created_at: NOW, updated_at: NOW,
    ...overrides,
  };
}

function buildPool() {
  const providers = new Map<string, Record<string, unknown>>();
  const templates = new Map<string, Record<string, unknown>>();
  const versions: Record<string, unknown>[] = [];
  const instances = new Map<string, Record<string, unknown>>();
  const queries: string[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push(sql);
    if (sql.includes('SELECT version FROM')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM test_execution_providers') && sql.includes('provider_id = $1')) {
      const row = providers.get(String(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO test_execution_providers') && sql.includes('RETURNING')) {
      const row = providerRow({
        provider_id: params[0], status: params[1], endpoint_ref: params[2],
        network_policy_json: JSON.parse(String(params[3])), infrastructure_credential_id: params[4],
        rollout_policy_json: JSON.parse(String(params[5])), updated_by: params[6], created_by: params[6],
      });
      providers.set(String(params[0]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_execution_providers') && sql.includes('RETURNING')) {
      const current = providers.get(String(params[0]));
      if (!current || Number(current.revision) !== Number(params[7])) return { rows: [], rowCount: 0 };
      const row = {
        ...current, status: params[1], endpoint_ref: params[2], network_policy_json: JSON.parse(String(params[3])),
        infrastructure_credential_id: params[4], rollout_policy_json: JSON.parse(String(params[5])),
        revision: String(Number(current.revision) + 1), updated_by: params[6],
      };
      providers.set(String(params[0]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('FROM test_environment_templates') && /template_id\s*=\s*\$1/.test(sql)) {
      const row = templates.get(String(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO test_environment_templates') && !sql.includes('RETURNING')) {
      templates.set(String(params[0]), templateRow({ template_id: params[0], name: params[1], created_by: params[2], updated_by: params[2] }));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM test_environment_template_versions') && sql.includes('digest=$2')) {
      const row = versions.find(item => item.template_id === params[0] && item.digest === params[1]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('MAX(version_number)')) {
      const max = versions.filter(item => item.template_id === params[0]).reduce((n, item) => Math.max(n, Number(item.version_number)), 0);
      return { rows: [{ next_version: String(max + 1) }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO test_environment_template_versions') && sql.includes('RETURNING')) {
      const row = {
        version_id: params[0], template_id: params[1], version_number: String(params[2]),
        recipe_json: JSON.parse(String(params[3])), digest: params[4], published_at: NOW, published_by: params[5],
      };
      versions.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_environment_templates') && sql.includes("status='published'")) {
      const current = templates.get(String(params[0]))!;
      const row = { ...current, name: params[1], status: 'published', current_version_id: params[2], revision: String(Number(current.revision) + 1), updated_by: params[3] };
      templates.set(String(params[0]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_environment_templates') && sql.includes("status='retired'")) {
      const current = templates.get(String(params[0]));
      if (!current || Number(current.revision) !== Number(params[2])) return { rows: [], rowCount: 0 };
      const row = { ...current, status: 'retired', revision: String(Number(current.revision) + 1), updated_by: params[1] };
      templates.set(String(params[0]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('FROM test_environment_template_versions v')) {
      const version = versions.find(item => item.version_id === params[0] && item.template_id === params[1]);
      const template = templates.get(String(params[1]));
      const row = version && template?.status === 'published' ? { digest: version.digest } : undefined;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO test_environment_instances')) {
      const key = `${String(params[1])}\u0000${String(params[0])}`;
      const duplicate = [...instances.values()].some(row => row.instance_id === params[0] || row.hand_id === params[5]);
      if (duplicate) return { rows: [], rowCount: 0 };
      const row = instanceRow({
        instance_id: params[0], tenant_id: params[1], provider_id: params[2], template_id: params[3],
        template_version_id: params[4], hand_id: params[5], status: params[6], lease_expires_at: params[7],
        recipe_digest: params[8],
      });
      instances.set(key, row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('FROM test_environment_instances') && sql.includes('tenant_id=$1 AND instance_id=$2')) {
      const row = instances.get(`${String(params[0])}\u0000${String(params[1])}`);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM test_environment_instances') && sql.includes('WHERE tenant_id=$1')) {
      const rows = [...instances.values()].filter(row => row.tenant_id === params[0]);
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('UPDATE test_environment_instances')) {
      const key = `${String(params[0])}\u0000${String(params[1])}`;
      const current = instances.get(key);
      const expected = sql.includes('SET status=$3,lease_expires_at=$4') ? params[4] : params[3];
      if (!current || Number(current.revision) !== Number(expected)) return { rows: [], rowCount: 0 };
      const row = sql.includes('SET status=$3,lease_expires_at=$4')
        ? { ...current, status: params[2], lease_expires_at: params[3], revision: String(Number(current.revision) + 1) }
        : sql.includes('SET lease_expires_at=$3')
          ? { ...current, lease_expires_at: params[2], revision: String(Number(current.revision) + 1) }
          : { ...current, status: params[2], revision: String(Number(current.revision) + 1) };
      instances.set(key, row);
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { pool: pool as never, providers, templates, versions, instances, queries };
}

const recipe = {
  packages: ['nodejs@22', 'git'],
  envKeys: ['NODE_ENV'],
  setupCommands: ['corepack enable'],
  resources: { cpu: '2', memoryMb: 4096, diskMb: 10240, timeoutMs: 600_000 },
};

describe('Environment Provider/Template/Instance 领域', () => {
  it('migration V8 创建 Provider、Template Version 与 Resource Reference 表', async () => {
    const { pool, queries } = buildPool();
    const store = new PgEnvironmentStore({ pool, tablePrefix: 'test' });
    await store.init();
    const sql = queries.join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_execution_providers');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_environment_templates');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_environment_template_versions');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_resource_references');
    expect(sql).toContain('infrastructure_credential_id TEXT');
    expect(queries.filter(item => item === 'BEGIN')).toHaveLength(20);
  });

  it('Provider 新建与更新必须 expectedRevision，保存 credentialId 而非 Secret', async () => {
    const { pool } = buildPool();
    const store = new PgEnvironmentStore({ pool, tablePrefix: 'test' });
    const created = await store.upsertProvider({
      providerId: 'acs', status: 'enabled', endpointRef: 'provider://acs',
      infrastructureCredentialId: 'cred-infra', networkPolicy: { egress: 'allowlisted' },
      rolloutPolicy: { mode: 'eligible' }, updatedBy: 'platform-admin',
    });
    expect(created).toMatchObject({ providerId: 'acs', revision: 1, infrastructureCredentialId: 'cred-infra' });
    await expect(store.upsertProvider({
      providerId: 'acs', status: 'draining', endpointRef: 'provider://acs', updatedBy: 'platform-admin',
    })).rejects.toMatchObject({ code: 'EXECUTION_PROVIDER_VERSION_CONFLICT' });
    const updated = await store.upsertProvider({
      providerId: 'acs', status: 'draining', endpointRef: 'provider://acs',
      expectedRevision: 1, updatedBy: 'platform-admin',
    });
    expect(updated).toMatchObject({ status: 'draining', revision: 2 });
    expect(JSON.stringify(updated)).not.toContain('secretRef');
  });

  it('Template 发布 immutable recipe version，相同 digest 幂等', async () => {
    const { pool, versions } = buildPool();
    const store = new PgEnvironmentStore({ pool, tablePrefix: 'test' });
    const first = await store.publishTemplate({ templateId: 'node-default', name: 'Node 默认环境', recipe, publishedBy: 'admin' });
    const second = await store.publishTemplate({ templateId: 'node-default', name: 'Node 默认环境', recipe, publishedBy: 'admin' });
    expect(first.created).toBe(true);
    expect(first.template).toMatchObject({ status: 'published', revision: 2 });
    expect(first.publishedVersion.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.created).toBe(false);
    expect(versions).toHaveLength(1);
  });

  it('recipe 禁止 Secret、Credential、instance/session/workspace ID 与疑似明文命令', async () => {
    expect(() => assertNoSensitiveRecipeFields(recipe)).not.toThrow();
    expect(() => assertNoSensitiveRecipeFields({ ...recipe, secretRef: 'ref-x' }))
      .toThrowError(expect.objectContaining({ code: 'ENVIRONMENT_RECIPE_SENSITIVE' }));
    const { pool } = buildPool();
    const store = new PgEnvironmentStore({ pool, tablePrefix: 'test' });
    for (const command of [
      'export API_TOKEN=abc',
      'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature" https://api.example',
      'tool --password:plaintext',
    ]) {
      await expect(store.publishTemplate({
        templateId: 'bad-template', name: 'bad',
        recipe: { ...recipe, setupCommands: [command] },
        publishedBy: 'admin',
      })).rejects.toMatchObject({ code: 'ENVIRONMENT_RECIPE_SENSITIVE' });
    }
  });

  it('retired Template 终态不可重新发布，版本冲突 fail closed', async () => {
    const { pool } = buildPool();
    const store = new PgEnvironmentStore({ pool, tablePrefix: 'test' });
    const published = await store.publishTemplate({ templateId: 'node-default', name: 'Node 默认环境', recipe, publishedBy: 'admin' });
    await expect(store.retireTemplate('node-default', 99, 'admin'))
      .rejects.toMatchObject({ code: 'ENVIRONMENT_TEMPLATE_VERSION_CONFLICT' });
    const retired = await store.retireTemplate('node-default', published.template.revision, 'admin');
    expect(retired.status).toBe('retired');
    await expect(store.publishTemplate({ templateId: 'node-default', name: 'Node 默认环境', recipe, publishedBy: 'admin' }))
      .rejects.toMatchObject({ code: 'ENVIRONMENT_TEMPLATE_RETIRED' });
  });

  it('Instance create 固化版本 digest，只持久化白名单字段', async () => {
    const { pool, providers, templates, versions } = buildPool();
    providers.set('acs', providerRow());
    templates.set('node-default', templateRow({ status: 'published', current_version_id: 'version-1' }));
    versions.push({ version_id: 'version-1', template_id: 'node-default', digest: 'digest-1' });
    const store = new PgEnvironmentStore({ pool, tablePrefix: 'test' });
    const created = await store.create({
      instanceId: 'instance-1', tenantId: 'acme', providerId: 'acs', templateId: 'node-default',
      templateVersionId: 'version-1', handId: 'hand-1', leaseExpiresAt: '2026-08-08T01:00:00.000Z',
      recipeDigest: 'digest-1',
      ...({ secret: 'must-not-persist' } as Record<string, string>),
    });
    expect(created).toMatchObject({
      instanceId: 'instance-1', tenantId: 'acme', providerId: 'acs', templateId: 'node-default',
      templateVersionId: 'version-1', handId: 'hand-1', status: 'provisioning', revision: 1,
      leaseExpiresAt: '2026-08-08T01:00:00.000Z', recipeDigest: 'digest-1', createdAt: NOW, updatedAt: NOW,
    });
    expect(Object.keys(created)).toEqual([
      'instanceId', 'tenantId', 'providerId', 'templateId', 'templateVersionId', 'handId', 'status',
      'leaseExpiresAt', 'revision', 'recipeDigest', 'createdAt', 'updatedAt',
    ]);
    expect(JSON.stringify(created)).not.toContain('must-not-persist');
  });

  it.each(['disabled', 'draining'] as const)('Provider %s 时 create/upsert 均禁止新 Instance', async status => {
    const { pool, providers, templates, versions } = buildPool();
    providers.set('acs', providerRow({ status }));
    templates.set('node-default', templateRow({ status: 'published' }));
    versions.push({ version_id: 'version-1', template_id: 'node-default', digest: 'digest-1' });
    const store = new PgEnvironmentStore({ pool, tablePrefix: 'test' });
    const base = {
      tenantId: 'acme', providerId: 'acs', templateId: 'node-default', templateVersionId: 'version-1',
      leaseExpiresAt: '2026-08-08T01:00:00.000Z', recipeDigest: 'digest-1',
    };
    await expect(store.create({ ...base, instanceId: 'instance-1', handId: 'hand-1' }))
      .rejects.toMatchObject({ code: 'ENVIRONMENT_INSTANCE_PROVIDER_UNAVAILABLE' });
    await expect(store.upsert({ ...base, instanceId: 'instance-2', handId: 'hand-2', status: 'provisioning' }))
      .rejects.toMatchObject({ code: 'ENVIRONMENT_INSTANCE_PROVIDER_UNAVAILABLE' });
  });

  it('Instance template/version/digest 必须一致，tenant 读取边界 fail closed', async () => {
    const { pool, providers, templates, versions } = buildPool();
    providers.set('acs', providerRow());
    templates.set('node-default', templateRow({ status: 'published' }));
    versions.push({ version_id: 'version-1', template_id: 'node-default', digest: 'digest-1' });
    const store = new PgEnvironmentStore({ pool, tablePrefix: 'test' });
    const base = {
      instanceId: 'instance-1', tenantId: 'acme', providerId: 'acs', templateVersionId: 'version-1',
      handId: 'hand-1', leaseExpiresAt: '2026-08-08T01:00:00.000Z',
    };
    await expect(store.create({ ...base, templateId: 'other-template' }))
      .rejects.toMatchObject({ code: 'ENVIRONMENT_INSTANCE_TEMPLATE_VERSION_INVALID' });
    await expect(store.create({ ...base, templateId: 'node-default', recipeDigest: 'wrong-digest' }))
      .rejects.toMatchObject({ code: 'ENVIRONMENT_INSTANCE_RECIPE_DIGEST_MISMATCH' });
    await store.create({ ...base, templateId: 'node-default', recipeDigest: 'digest-1' });
    expect(await store.get('other-tenant', 'instance-1')).toBeNull();
    expect(await store.listForTenant('other-tenant')).toEqual([]);
    expect(await store.listForTenant('acme')).toHaveLength(1);
    await expect(store.transition({ tenantId: 'other-tenant', instanceId: 'instance-1', status: 'ready', expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'ENVIRONMENT_INSTANCE_NOT_FOUND' });
  });

  it('Instance upsert/renewLease/transition 使用乐观 revision 并执行有向生命周期', async () => {
    const { pool, providers, templates, versions } = buildPool();
    providers.set('acs', providerRow());
    templates.set('node-default', templateRow({ status: 'published' }));
    versions.push({ version_id: 'version-1', template_id: 'node-default', digest: 'digest-1' });
    const store = new PgEnvironmentStore({ pool, tablePrefix: 'test' });
    const base = {
      instanceId: 'instance-1', tenantId: 'acme', providerId: 'acs', templateId: 'node-default',
      templateVersionId: 'version-1', handId: 'hand-1', leaseExpiresAt: '2026-08-08T01:00:00.000Z',
      recipeDigest: 'digest-1',
    };
    await store.create(base);
    const ready = await store.upsert({ ...base, status: 'ready', expectedRevision: 1 });
    expect(ready).toMatchObject({ status: 'ready', revision: 2 });
    await expect(store.renewLease({
      tenantId: 'acme', instanceId: 'instance-1', leaseExpiresAt: '2026-08-08T02:00:00.000Z', expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'ENVIRONMENT_INSTANCE_VERSION_CONFLICT' });
    const renewed = await store.renewLease({
      tenantId: 'acme', instanceId: 'instance-1', leaseExpiresAt: '2026-08-08T02:00:00.000Z', expectedRevision: 2,
    });
    expect(renewed).toMatchObject({ leaseExpiresAt: '2026-08-08T02:00:00.000Z', revision: 3 });
    await expect(store.transition({ tenantId: 'acme', instanceId: 'instance-1', status: 'provisioning', expectedRevision: 3 }))
      .rejects.toMatchObject({ code: 'ENVIRONMENT_INSTANCE_TRANSITION_INVALID' });
    const draining = await store.transition('acme', 'instance-1', 'draining', 3);
    const retired = await store.transition('acme', 'instance-1', 'retired', draining.revision);
    expect(retired).toMatchObject({ status: 'retired', revision: 5 });
    await expect(store.renewLease('acme', 'instance-1', '2026-08-08T03:00:00.000Z', retired.revision))
      .rejects.toMatchObject({ code: 'ENVIRONMENT_INSTANCE_TRANSITION_INVALID' });
  });
});
