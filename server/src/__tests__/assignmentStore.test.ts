import { describe, expect, it, vi } from 'vitest';

import { PgAssignmentStore, resolveAssignment } from '../data/assignments/index.js';
import type { OrgAgentRecord } from '../data/orgAgents/types.js';

const NOW = '2026-08-08T00:00:00.000Z';

function assignmentSetRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 'acme',
    resource_type: 'org_agent',
    resource_id: 'oa-1',
    source: 'legacy_projection',
    version: 2,
    created_at: NOW,
    created_by: 'system',
    updated_at: NOW,
    updated_by: 'system',
    ...overrides,
  };
}

function orgAgent(): OrgAgentRecord {
  return {
    id: 'oa-1',
    tenantId: 'acme',
    name: '销售专家',
    description: '',
    starterPrompts: [],
    instructions: 'test',
    allowedSkills: [],
    audience: { exposure: 'deny_users', usernames: ['Alice', 'missing-user'] },
    guardrail: {
      enabled: false,
      scopeDescription: '',
      rejectionMessage: '',
      strictness: 'strict',
    },
    enabled: true,
    createdAt: NOW,
    createdBy: 'admin-1',
    updatedAt: NOW,
    updatedBy: 'admin-1',
  };
}

describe('Resource Assignment 与 Personal Preference', () => {
  it('显式 deny 优先于 everyone allow；无匹配返回 needs_assignment', () => {
    expect(resolveAssignment([
      { assigneeType: 'everyone', effect: 'allow' },
      { assigneeType: 'user', assigneeId: 'user-1', effect: 'deny' },
    ], { userId: 'user-1' })).toBe('denied');
    expect(resolveAssignment([
      { assigneeType: 'directory_group', assigneeId: 'dept-1', effect: 'allow' },
    ], { userId: 'user-1', directoryGroupIds: ['dept-1'] })).toBe('assigned');
    expect(resolveAssignment([], { userId: 'user-1' })).toBe('needs_assignment');
  });

  it('migration 创建带 set version 的 Assignment 与 self-owned Preference 表', async () => {
    const queries: string[] = [];
    const query = async (sql: string) => {
      queries.push(sql);
      if (sql.includes('SELECT version FROM')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    };
    const pool = { query, connect: async () => ({ query, release: () => undefined }) };
    const store = new PgAssignmentStore({ pool: pool as never, tablePrefix: 'test' });

    await store.init();

    const sql = queries.join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_resource_assignment_sets');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_resource_assignments');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_user_resource_preferences');
    expect(sql).toContain("assignee_type = 'everyone' AND assignee_id IS NULL");
    expect(queries.filter(item => item === 'BEGIN')).toHaveLength(33);
  });

  it('legacy username 仅在同租户唯一命中时转 immutable userId；未解析 deny 记 issue 且不误授权同名账号', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const query = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, ...(params ? { params } : {}) });
      if (sql.includes('SELECT * FROM test_resource_assignment_sets')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('test_user_resource_preferences') && sql.includes('RETURNING 1')) {
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      }
      if (sql.includes('test_governance_migration_issues') && sql.includes('RETURNING *')) {
        return {
          rows: [{
            issue_id: 'issue-1',
            issue_type: params?.[1],
            tenant_id: params?.[2],
            resource_type: params?.[3],
            resource_id: params?.[4],
            legacy_key: params?.[5],
            detail_json: JSON.parse(String(params?.[6] ?? '{}')),
            status: 'open',
            version: 1,
            created_at: NOW,
            created_by: params?.[7],
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    };
    const pool = { query, connect: async () => ({ query, release: () => undefined }) };
    const store = new PgAssignmentStore({ pool: pool as never, tablePrefix: 'test' });

    const result = await store.backfillLegacyAssignments({
      platformTenantId: 'pantheon',
      projectedBy: 'system:governance-m1',
      users: [
        { id: 'user-alice', username: 'alice', tenantId: 'acme' },
        { id: 'user-other-alice', username: 'Alice', tenantId: 'other' },
      ],
      orgAgents: [orgAgent()],
      tenantSkillConfigs: {
        acme: {
          skills: {
            'skill-allow': { enabled: true, exposure: 'allow_users', usernames: ['ALICE'] },
            'skill-off': { enabled: false, exposure: 'all', usernames: [] },
          },
        },
      },
      userSkillConfigs: {
        alice: { selectedSkills: ['skill-allow', 'skill-own'] },
      },
    });

    expect(result).toEqual({
      resourceSetsProjected: 3,
      assignmentsProjected: 3,
      preferencesProjected: 0,
      issuesRecorded: 2,
    });
    const assignmentInserts = queries.filter(item =>
      item.sql.includes('INSERT INTO test_resource_assignments'),
    );
    expect(assignmentInserts.some(item =>
      item.params?.[4] === 'user' && item.params?.[5] === 'user-alice' && item.params?.[6] === 'deny',
    )).toBe(true);
    expect(assignmentInserts.some(item => item.params?.[5] === 'missing-user')).toBe(false);
    expect(queries.some(item =>
      item.sql.includes('test_governance_migration_issues')
      && item.params?.[1] === 'deny_username_assignment_unresolved'
      && item.params?.[5] === 'missing-user',
    )).toBe(true);
    expect(queries.some(item =>
      item.sql.includes('test_governance_migration_issues')
      && item.params?.[1] === 'preference_username_unresolved',
    )).toBe(true);
  });

  it('personal Skill preference 使用 immutable 映射 ID，Credential backfill 生成 owner Assignment', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const query = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, ...(params ? { params } : {}) });
      if (sql.includes('SELECT * FROM test_resource_assignment_sets')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    };
    const store = new PgAssignmentStore({
      pool: { query, connect: async () => ({ query, release: () => undefined }) } as never,
      tablePrefix: 'test',
    });
    await store.backfillLegacyAssignments({
      platformTenantId: 'pantheon', projectedBy: 'system:governance-m1',
      users: [{ id: 'user-bob', username: 'bob', tenantId: 'acme' }],
      orgAgents: [], tenantSkillConfigs: {},
      userSkillConfigs: { bob: { selectedSkills: ['my-private-skill'] } },
      resolveSkillResourceId: (user, skillId) => `personal:${user.id}:${skillId}`,
    });
    expect(queries.some(item => item.sql.includes('INSERT INTO test_user_resource_preferences')
      && item.params?.[1] === 'personal:user-bob:my-private-skill')).toBe(true);

    queries.length = 0;
    await store.backfillLegacyCredentialAssignments({
      credentials: [{ credentialId: 'cred-1', tenantId: 'acme', ownerUserId: 'user-bob' }],
      projectedBy: 'system:governance-m1',
    });
    expect(queries.some(item => item.sql.includes('INSERT INTO test_resource_assignments')
      && item.params?.[2] === 'credential'
      && item.params?.[3] === 'cred-1'
      && item.params?.[5] === 'user-bob')).toBe(true);
  });

  it('legacy 内置 Connector 为客户组织投影 everyone allow，且不覆盖显式治理', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const query = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, ...(params ? { params } : {}) });
      if (sql.includes('SELECT * FROM test_resource_assignment_sets')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    };
    const store = new PgAssignmentStore({
      pool: { query, connect: async () => ({ query, release: () => undefined }) } as never,
      tablePrefix: 'test',
      platformTenantId: 'pantheon',
    });
    await expect(store.backfillLegacyConnectorAssignments({
      tenantIds: ['pantheon', 'acme', 'acme'],
      connectorIds: ['google_workspace', 'github', 'google_workspace'],
      projectedBy: 'system:governance-m1',
    })).resolves.toEqual({ resourceSetsProjected: 2 });
    const connectorAssignments = queries.filter(item =>
      item.sql.includes('INSERT INTO test_resource_assignments') && item.params?.[2] === 'connector',
    );
    expect(connectorAssignments).toHaveLength(2);
    expect(connectorAssignments.every(item =>
      item.params?.[1] === 'acme'
      && item.params?.[4] === 'everyone'
      && item.params?.[5] === null
      && item.params?.[6] === 'allow',
    )).toBe(true);
    expect(connectorAssignments.some(item => item.params?.[3] === 'google_workspace')).toBe(true);

    const governedQuery = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM test_resource_assignment_sets')) {
        return { rows: [assignmentSetRow({ resource_type: 'connector', resource_id: 'google_workspace', source: 'governance' })], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const governedStore = new PgAssignmentStore({
      pool: { connect: async () => ({ query: governedQuery, release: () => undefined }) } as never,
      tablePrefix: 'test',
      platformTenantId: 'pantheon',
    });
    await expect(governedStore.backfillLegacyConnectorAssignments({
      tenantIds: ['acme'], connectorIds: ['google_workspace'], projectedBy: 'system:governance-m1',
    })).resolves.toEqual({ resourceSetsProjected: 0 });
    expect(governedQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO test_resource_assignments'), expect.anything());
  });

  it('effective binding 同时计算 user/everyone/agent，deny 优先；directory group 未解析时 fail closed', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const query = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT 1') && sql.includes("assignee_type='directory_group'")) return { rows: [], rowCount: 0 };
      return {
        rows: [{ resource_id: 'skill-1', binding_id: 'assignment-1', assignment_version: 3 }],
        rowCount: 1,
      };
    };
    const store = new PgAssignmentStore({ pool: { query } as never, tablePrefix: 'test' });
    await expect(store.listEffectiveResourceIds('acme', 'user-1', 'skill', 'agent-1')).resolves.toEqual([{
      resourceId: 'skill-1', bindingId: 'assignment-1', assignmentVersion: 3, finalEffect: 'allow', bindings: [],
    }]);
    const effectiveSql = queries[1].sql;
    expect(effectiveSql).toContain("s.resource_status='enabled'");
    expect(effectiveSql).toContain("a.assignee_type='agent' AND a.assignee_id=$4");
    expect(effectiveSql).toContain("NOT BOOL_OR(a.effect='deny')");
    expect(effectiveSql).toContain("a.assignee_type='directory_group' AND a.assignee_id=ANY($5::text[])");
    expect(queries[1].params).toEqual(['acme', 'user-1', 'skill', 'agent-1', []]);

    const resolvedQueries: unknown[][] = [];
    const resolved = new PgAssignmentStore({
      pool: { query: vi.fn().mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes('SELECT 1')) return { rows: [{ found: 1 }], rowCount: 1 };
        resolvedQueries.push(params);
        return { rows: [{ resource_id: 'skill-1', binding_id: 'group-binding', assignment_version: 4 }], rowCount: 1 };
      }) } as never,
      tablePrefix: 'test',
      resolveDirectoryGroupIds: vi.fn().mockResolvedValue(['group-local-1']),
    });
    await expect(resolved.listEffectiveResourceIds('acme', 'user-1', 'skill')).resolves.toEqual([{
      resourceId: 'skill-1', bindingId: 'group-binding', assignmentVersion: 4, finalEffect: 'allow', bindings: [],
    }]);
    expect(resolvedQueries[0]?.[4]).toEqual(['group-local-1']);

    const blocked = new PgAssignmentStore({
      pool: { query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 }) } as never,
      tablePrefix: 'test',
    });
    await expect(blocked.listEffectiveResourceIds('acme', 'user-1', 'skill', 'agent-1'))
      .rejects.toMatchObject({ code: 'ASSIGNMENT_GROUP_SUBJECT_UNRESOLVED' });
  });

  it('expectedVersion=0 原子创建新的 Assignment Set', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM test_resource_assignment_sets')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO test_resource_assignment_sets')) {
        return { rows: [assignmentSetRow({ source: 'governance', version: 1, updated_by: 'admin-1' })], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release: vi.fn() };
    const store = new PgAssignmentStore({
      pool: { connect: vi.fn().mockResolvedValue(client) } as never,
      tablePrefix: 'test',
    });
    await expect(store.replaceAssignments('acme', 'org_agent', 'oa-1', [], 0, 'admin-1'))
      .resolves.toMatchObject({ version: 1, assignments: [] });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO test_resource_assignment_sets'), [
      'acme', 'org_agent', 'oa-1', 'admin-1', null, 'enabled',
    ]);
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

  it('Store 边界拒绝超过 500 条的批量规则，不能绕过路由上限', async () => {
    const connect = vi.fn();
    const store = new PgAssignmentStore({ pool: { connect } as never, tablePrefix: 'test' });
    await expect(store.replaceAssignmentSetsAtomically('acme', [{
      resourceType: 'org_knowledge', resourceId: 'taskboard-projects', expectedVersion: 0,
      assignments: Array.from({ length: 501 }, (_, index) => ({
        assigneeType: 'user' as const, assigneeId: `user-${index}`, effect: 'allow' as const,
      })),
    }], 'admin-1')).rejects.toMatchObject({ code: 'ASSIGNMENT_INVALID' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('批量 Assignment 在同一事务中锁定全部资源，任一版本冲突会整体回滚', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT * FROM test_resource_assignment_sets')) {
        const resourceId = String(params?.[2]);
        return { rows: [assignmentSetRow({ resource_type: 'org_knowledge', resource_id: resourceId,
          version: resourceId === 'taskboard-tasks' ? 2 : 1 })], rowCount: 1 };
      }
      if (sql.includes('UPDATE test_resource_assignment_sets')) {
        return { rows: [assignmentSetRow({ resource_type: 'org_knowledge', resource_id: params?.[2], version: 2 })], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const store = new PgAssignmentStore({ pool: { connect: vi.fn().mockResolvedValue(client) } as never, tablePrefix: 'test' });

    await expect(store.replaceAssignmentSetsAtomically('acme', [
      { resourceType: 'org_knowledge', resourceId: 'taskboard-projects', expectedVersion: 1, assignments: [] },
      { resourceType: 'org_knowledge', resourceId: 'taskboard-tasks', expectedVersion: 1, assignments: [] },
    ], 'admin-1')).rejects.toMatchObject({ code: 'ASSIGNMENT_SET_VERSION_CONFLICT' });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
    expect(query.mock.calls.filter(call => String(call[0]).includes('pg_advisory_xact_lock'))).toHaveLength(2);
  });

  it('批量写后的 projection callback 失败会与 Assignment 一起回滚', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT * FROM test_resource_assignment_sets')) {
        return { rows: [assignmentSetRow({ resource_type: 'org_knowledge', resource_id: params?.[2], version: 1 })], rowCount: 1 };
      }
      if (sql.includes('UPDATE test_resource_assignment_sets')) {
        return { rows: [assignmentSetRow({ resource_type: 'org_knowledge', resource_id: params?.[2], version: 2 })], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const store = new PgAssignmentStore({ pool: { connect: vi.fn().mockResolvedValue(client) } as never, tablePrefix: 'test' });
    const afterWrite = vi.fn(async () => { throw new Error('OUTBOX_FAILED'); });
    await expect(store.replaceAssignmentSetsAtomically('acme', [{ resourceType: 'org_knowledge',
      resourceId: 'taskboard-projects', expectedVersion: 1, assignments: [] }], 'admin-1', afterWrite))
      .rejects.toThrow('OUTBOX_FAILED');
    expect(afterWrite).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query).not.toHaveBeenCalledWith('COMMIT');
  });

  it('高级编辑未改动的规则会保留既有 migration origin', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT * FROM test_resource_assignment_sets')) return { rows: [assignmentSetRow()], rowCount: 1 };
      if (sql.includes('UPDATE test_resource_assignment_sets')) return { rows: [assignmentSetRow({ version: 3 })], rowCount: 1 };
      if (sql.includes('SELECT assignee_type,assignee_id,effect,origin')) return { rows: [{
        assignee_type: 'user', assignee_id: 'user-1', effect: 'allow', origin: 'migration',
      }], rowCount: 1 };
      if (sql.includes('INSERT INTO test_resource_assignments')) {
        const inputs = JSON.parse(String(params?.[4])) as Array<Record<string, unknown>>;
        return { rows: inputs.map(input => ({
          assignment_id: input.assignment_id, tenant_id: params?.[0], resource_type: params?.[1], resource_id: params?.[2],
          assignee_type: input.assignee_type, assignee_id: input.assignee_id, effect: input.effect, origin: input.origin,
          version: 1, created_at: NOW, created_by: params?.[3], updated_at: NOW, updated_by: params?.[3],
        })), rowCount: inputs.length };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const store = new PgAssignmentStore({ pool: { connect: vi.fn().mockResolvedValue(client) } as never, tablePrefix: 'test' });
    const updated = await store.replaceAssignments('acme', 'org_knowledge', 'kb-1', [
      { assigneeType: 'user', assigneeId: 'user-1', effect: 'allow' },
    ], 2, 'admin-1');
    expect(updated.assignments[0]?.origin).toBe('migration');
  });

  it('治理写以 AssignmentSet expectedVersion 原子替换，拒绝同一 assignee 的冲突规则', async () => {
    let queryCount = 0;
    const query = async (sql: string, params?: unknown[]) => {
      queryCount += 1;
      if (sql.includes('SELECT * FROM test_resource_assignment_sets')) {
        return { rows: [assignmentSetRow()], rowCount: 1 };
      }
      if (sql.includes('UPDATE test_resource_assignment_sets')) {
        return {
          rows: [assignmentSetRow({ source: 'governance', version: 3, updated_by: 'admin-1' })],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO test_resource_assignments')) {
        const inputs = JSON.parse(String(params?.[4])) as Array<Record<string, unknown>>;
        return {
          rows: inputs.map(input => ({
            assignment_id: input.assignment_id,
            tenant_id: params?.[0],
            resource_type: params?.[1],
            resource_id: params?.[2],
            assignee_type: input.assignee_type,
            assignee_id: input.assignee_id,
            effect: input.effect,
            origin: input.origin,
            version: 1,
            created_at: NOW,
            created_by: params?.[3],
            updated_at: NOW,
            updated_by: params?.[3],
          })),
          rowCount: inputs.length,
        };
      }
      return { rows: [], rowCount: 1 };
    };
    const pool = { query, connect: async () => ({ query, release: () => undefined }) };
    const store = new PgAssignmentStore({ pool: pool as never, tablePrefix: 'test' });

    const updated = await store.replaceAssignments('acme', 'org_agent', 'oa-1', [
      { assigneeType: 'everyone', effect: 'allow' },
      { assigneeType: 'user', assigneeId: 'user-1', effect: 'deny' },
    ], 2, 'admin-1');
    expect(updated).toMatchObject({ source: 'governance', version: 3 });
    expect(updated.assignments).toHaveLength(2);

    const beforeInvalid = queryCount;
    await expect(store.replaceAssignments('acme', 'org_agent', 'oa-1', [
      { assigneeType: 'user', assigneeId: 'user-1', effect: 'allow' },
      { assigneeType: 'user', assigneeId: 'user-1', effect: 'deny' },
    ], 3, 'admin-1')).rejects.toMatchObject({ code: 'INVALID_ASSIGNMENT_ASSIGNEE' });
    expect(queryCount).toBe(beforeInvalid);
  });
});
