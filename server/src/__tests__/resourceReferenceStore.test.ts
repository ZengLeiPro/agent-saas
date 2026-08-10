import { describe, expect, it } from 'vitest';

import { PgResourceReferenceStore } from '../data/resourceReferences/index.js';

const NOW = '2026-08-08T00:00:00.000Z';

function buildPool() {
  let rows: Record<string, unknown>[] = [];
  const queries: string[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push(sql);
    if (sql.includes('SELECT version FROM')) return { rows: [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }] };
    if (sql.includes('DELETE FROM test_resource_references')) {
      rows = rows.filter(row => row.tenant_id !== params[0] || row.source_type !== params[1] || row.source_id !== params[2]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO test_resource_references') && sql.includes('RETURNING')) {
      const row = {
        reference_id: params[0], tenant_id: params[1], source_type: params[2], source_id: params[3],
        source_version: params[4], target_type: params[5], target_id: params[6], target_version: params[7],
        relation: params[8], created_at: NOW, created_by: params[9],
      };
      rows.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('target_type=$2 AND target_id=$3')) {
      const result = rows.filter(row => row.tenant_id === params[0] && row.target_type === params[1] && row.target_id === params[2]);
      return { rows: result, rowCount: result.length };
    }
    if (sql.includes('source_type=$2 AND source_id=$3')) {
      const result = rows.filter(row => row.tenant_id === params[0] && row.source_type === params[1] && row.source_id === params[2]);
      return { rows: result, rowCount: result.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { pool: pool as never, queries, getRows: () => rows };
}

describe('Resource Reference Index', () => {
  it('replaceSourceReferences 原子替换并对重复引用去重', async () => {
    const { pool, getRows } = buildPool();
    const store = new PgResourceReferenceStore({ pool, tablePrefix: 'test' });
    const result = await store.replaceSourceReferences({
      tenantId: 'acme', sourceType: 'org_agent', sourceId: 'oa-1', sourceVersion: '3', updatedBy: 'admin',
      references: [
        { targetType: 'skill', targetId: 'skill-1', targetVersion: '2', relation: 'uses' },
        { targetType: 'skill', targetId: 'skill-1', targetVersion: '2', relation: 'uses' },
        { targetType: 'connector', targetId: 'github', targetVersion: 'v1', relation: 'uses' },
      ],
    });
    expect(result).toHaveLength(2);
    expect(getRows()).toHaveLength(2);
    expect(result[0].sourceVersion).toBe('3');
  });

  it('同名 source/target 严格按 tenant 隔离，替换不会跨租户删除', async () => {
    const { pool } = buildPool();
    const store = new PgResourceReferenceStore({ pool, tablePrefix: 'test' });
    await store.replaceSourceReferences({
      tenantId: 'acme', sourceType: 'org_agent', sourceId: 'oa-1', updatedBy: 'admin',
      references: [{ targetType: 'skill', targetId: 'skill-1', relation: 'uses' }],
    });
    await store.replaceSourceReferences({
      tenantId: 'beta', sourceType: 'org_agent', sourceId: 'oa-1', updatedBy: 'admin',
      references: [{ targetType: 'skill', targetId: 'skill-1', relation: 'uses' }],
    });
    await expect(store.listReferencers('acme', 'skill', 'skill-1')).resolves.toHaveLength(1);
    await expect(store.listReferencers('beta', 'skill', 'skill-1')).resolves.toHaveLength(1);
  });

  it('自引用与空 ID/relation fail closed', async () => {
    const { pool } = buildPool();
    const store = new PgResourceReferenceStore({ pool, tablePrefix: 'test' });
    await expect(store.replaceSourceReferences({
      tenantId: 'acme', sourceType: 'org_agent', sourceId: 'oa-1', updatedBy: 'admin',
      references: [{ targetType: 'org_agent', targetId: 'oa-1', relation: 'uses' }],
    })).rejects.toMatchObject({ code: 'RESOURCE_REFERENCE_INVALID' });
    await expect(store.replaceSourceReferences({
      tenantId: 'acme', sourceType: '', sourceId: 'oa-1', updatedBy: 'admin', references: [],
    })).rejects.toMatchObject({ code: 'RESOURCE_REFERENCE_INVALID' });
  });

  it('有引用时 preview 禁止硬删，assertHardDeleteAllowed 抛稳定错误', async () => {
    const { pool } = buildPool();
    const store = new PgResourceReferenceStore({ pool, tablePrefix: 'test' });
    await store.replaceSourceReferences({
      tenantId: 'acme', sourceType: 'org_agent', sourceId: 'oa-1', updatedBy: 'admin',
      references: [{ targetType: 'environment_template', targetId: 'env-1', relation: 'default_environment' }],
    });
    const impact = await store.previewRetirement('acme', 'environment_template', 'env-1');
    expect(impact).toMatchObject({ hardDeleteAllowed: false, referenceCount: 1 });
    await expect(store.assertHardDeleteAllowed('acme', 'environment_template', 'env-1'))
      .rejects.toMatchObject({ code: 'RESOURCE_HARD_DELETE_BLOCKED' });
  });

  it('无引用允许硬删；listDependencies 提供依赖面', async () => {
    const { pool } = buildPool();
    const store = new PgResourceReferenceStore({ pool, tablePrefix: 'test' });
    await expect(store.assertHardDeleteAllowed('acme', 'skill', 'unused')).resolves.toBeUndefined();
    await store.replaceSourceReferences({
      tenantId: 'acme', sourceType: 'org_agent', sourceId: 'oa-1', updatedBy: 'admin',
      references: [{ targetType: 'skill', targetId: 'skill-1', relation: 'uses' }],
    });
    await expect(store.listDependencies('acme', 'org_agent', 'oa-1')).resolves.toHaveLength(1);
  });
});
