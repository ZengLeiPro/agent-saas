import { describe, expect, it } from 'vitest';

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
    expect(queries.filter(item => item === 'BEGIN')).toHaveLength(11);
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
        return {
          rows: [{
            assignment_id: params?.[0],
            tenant_id: params?.[1],
            resource_type: params?.[2],
            resource_id: params?.[3],
            assignee_type: params?.[4],
            assignee_id: params?.[5],
            effect: params?.[6],
            origin: params?.[7],
            version: 1,
            created_at: NOW,
            created_by: params?.[8],
            updated_at: NOW,
            updated_by: params?.[8],
          }],
          rowCount: 1,
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
