import { describe, expect, it, vi } from 'vitest';

import { PgDirectoryGroupStore } from '../data/directoryGroups/index.js';

const NOW = '2026-08-10T00:00:00.000Z';

function groupRow(overrides: Record<string, unknown> = {}) {
  return {
    group_id: 'group-local-1', tenant_id: 'tenant-a', source: 'dingtalk',
    external_group_id: 'dept-9', display_name: '销售部', parent_group_id: null,
    status: 'active', version: 1, created_at: NOW, updated_at: NOW, ...overrides,
  };
}

describe('PgDirectoryGroupStore', () => {
  it('只用本地 groupId 解析有效成员群组', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ group_id: 'group-local-1' }], rowCount: 1 });
    const store = new PgDirectoryGroupStore({ pool: { query } as never, tablePrefix: 'test' });
    await expect(store.listGroupIdsForUser('tenant-a', 'user-1')).resolves.toEqual(['group-local-1']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("g.status='active'"), ['tenant-a', 'user-1']);
  });

  it('投影写入前拒绝跨租户成员，不产生数据库副作用', async () => {
    const connect = vi.fn();
    const store = new PgDirectoryGroupStore({
      pool: { connect } as never,
      tablePrefix: 'test',
      validateMember: vi.fn().mockResolvedValue(false),
    });
    await expect(store.upsertProjection({
      groupId: 'group-local-1', tenantId: 'tenant-a', source: 'dingtalk',
      externalGroupId: 'dept-9', sourceRevision: 'rev-1', displayName: '销售部', status: 'active', memberUserIds: ['user-other'],
    })).rejects.toThrow('DIRECTORY_MEMBER_TENANT_MISMATCH');
    expect(connect).not.toHaveBeenCalled();
  });

  it('V18 migration 包含可延迟、并发串行化的数据库防环约束', async () => {
    const queries: string[] = [];
    const query = vi.fn().mockImplementation(async (sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    });
    const store = new PgDirectoryGroupStore({
      pool: { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as never,
      tablePrefix: 'test',
    });
    await store.init();
    const sql = queries.join('\n');
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER test_directory_group_acyclic');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('WITH RECURSIVE ancestors(group_id,parent_group_id,visited,cycle)');
  });

  it('应用层立即拒绝 self cycle', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const store = new PgDirectoryGroupStore({
      pool: { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as never,
      tablePrefix: 'test',
    });
    await expect(store.upsertProjection({
      groupId: 'g-self', tenantId: 'tenant-a', source: 'governance', displayName: 'Self',
      parentGroupId: 'g-self', status: 'active', memberUserIds: [],
    })).rejects.toThrow('DIRECTORY_GROUP_CYCLE');
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('应用层祖先递归携带 visited path 并在已有长环上可终止', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FOR SHARE')) return { rows: [{ exists: true }], rowCount: 1 };
      if (sql.includes('WITH RECURSIVE ancestors')) return { rows: [{ cycle: true }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const store = new PgDirectoryGroupStore({
      pool: { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as never,
      tablePrefix: 'test',
    });
    await expect(store.upsertProjection({
      groupId: 'g-tail', tenantId: 'tenant-a', source: 'governance', displayName: 'Tail',
      parentGroupId: 'g-a', status: 'active', memberUserIds: [],
    })).rejects.toThrow('DIRECTORY_GROUP_CYCLE');
    const recursiveSql = String(query.mock.calls.find(([sql]) => String(sql).includes('WITH RECURSIVE'))?.[0]);
    expect(recursiveSql).toContain('visited');
    expect(recursiveSql).toContain('WHERE NOT g.group_id=ANY(a.visited)');
  });

  it('保留不可变本地 ID，并在事务内替换目录成员投影', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO test_directory_groups')) return { rows: [groupRow({ version: 2 })], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release: vi.fn() };
    const store = new PgDirectoryGroupStore({
      pool: { connect: vi.fn().mockResolvedValue(client) } as never,
      tablePrefix: 'test',
      validateMember: vi.fn().mockResolvedValue(true),
    });
    await expect(store.upsertProjection({
      groupId: 'group-local-1', tenantId: 'tenant-a', source: 'dingtalk',
      externalGroupId: 'dept-9', sourceRevision: 'rev-2', displayName: '销售部', status: 'active', memberUserIds: ['user-1'],
    })).resolves.toMatchObject({ groupId: 'group-local-1', externalGroupId: 'dept-9', version: 2 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO test_directory_group_members'), [
      'tenant-a', 'group-local-1', 'user-1', 'dingtalk',
    ]);
    expect(query).toHaveBeenCalledWith('COMMIT');
  });
});
