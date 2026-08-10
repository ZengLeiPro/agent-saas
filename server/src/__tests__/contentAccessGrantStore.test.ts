import { describe, expect, it } from 'vitest';

import {
  PgContentAccessGrantStore,
  type ContentAccessGrantScope,
} from '../data/contentAccess/index.js';

const FUTURE = '2099-08-09T00:00:00.000Z';
const CHECKED_AT = '2026-08-09T00:00:00.000Z';

function buildPool() {
  const grants = new Map<string, Record<string, unknown>>();
  const queries: string[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push(sql);
    if (sql.includes('SELECT version FROM')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO test_content_access_grants')) {
      const row = {
        grant_id: params[0], tenant_id: params[1], subject_user_id: params[2],
        target_type: params[3], target_id: params[4], scopes: params[5],
        purpose: params[6], reason_code: params[7], expires_at: params[8], status: 'active',
        revision: '1', created_by: params[9], revoked_by: null,
      };
      grants.set(String(params[0]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('$6=ANY(scopes)')) {
      const at = (params[4] as Date).getTime();
      const row = [...grants.values()].find(candidate =>
        candidate.tenant_id === params[0]
        && candidate.subject_user_id === params[1]
        && candidate.target_type === params[2]
        && candidate.target_id === params[3]
        && candidate.status === 'active'
        && new Date(String(candidate.expires_at)).getTime() > at
        && (candidate.scopes as string[]).includes(String(params[5])));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('SELECT * FROM test_content_access_grants')) {
      const rows = [...grants.values()].filter(row =>
        row.tenant_id === params[0]
        && (params[1] === null || row.subject_user_id === params[1])
        && (params[2] === null || row.status === params[2]));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('UPDATE test_content_access_grants')) {
      const row = grants.get(String(params[1]));
      if (!row || row.tenant_id !== params[0] || row.status !== 'active'
        || Number(row.revision) !== Number(params[2])) return { rows: [], rowCount: 0 };
      const updated = {
        ...row,
        status: 'revoked',
        revision: String(Number(row.revision) + 1),
        revoked_by: params[3],
      };
      grants.set(String(params[1]), updated);
      return { rows: [updated], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { pool: pool as never, grants, queries };
}

const createInput = {
  tenantId: 'acme',
  subjectUserId: 'reviewer-1',
  targetType: 'session' as const,
  targetId: 'session-1',
  scopes: ['qa_read', 'session_export', 'qa_read'] as ContentAccessGrantScope[],
  purpose: 'incident-review',
  reasonCode: 'INCIDENT_2026_08',
  expiresAt: FUTURE,
  createdBy: 'security-admin',
};

describe('Content Access Grant Store', () => {
  it('使用 governance table prefix 创建 active Grant，并规范化 scope', async () => {
    const { pool, queries } = buildPool();
    const store = new PgContentAccessGrantStore({ pool, tablePrefix: 'test' });

    const grant = await store.create(createInput);

    expect(store.grantsTable).toBe('test_content_access_grants');
    expect(grant).toMatchObject({
      tenantId: 'acme', subjectUserId: 'reviewer-1', scopes: ['qa_read', 'session_export'],
      purpose: 'incident-review', reasonCode: 'INCIDENT_2026_08', status: 'active',
      revision: 1, createdBy: 'security-admin',
    });
    expect(grant.grantId).toMatch(/^[0-9a-f-]{36}$/);
    expect(queries.join('\n')).toContain("VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',1,$10)");
  });

  it('list 严格按 tenant、subject 与 status 过滤', async () => {
    const { pool } = buildPool();
    const store = new PgContentAccessGrantStore({ pool, tablePrefix: 'test' });
    await store.create(createInput);
    await store.create({ ...createInput, tenantId: 'beta' });
    await store.create({ ...createInput, subjectUserId: 'reviewer-2' });

    const grants = await store.list({ tenantId: 'acme', subjectUserId: 'reviewer-1', status: 'active' });

    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ tenantId: 'acme', subjectUserId: 'reviewer-1' });
  });

  it('authorize 仅允许 tenant/user/scope 匹配且 active、未过期的 Grant', async () => {
    const { pool, grants } = buildPool();
    const store = new PgContentAccessGrantStore({ pool, tablePrefix: 'test' });
    const active = await store.create(createInput);

    await expect(store.authorize({
      tenantId: 'acme', subjectUserId: 'reviewer-1', targetType: 'session', targetId: 'session-1', scope: 'qa_read', at: CHECKED_AT,
    })).resolves.toBe(true);
    await expect(store.authorize({
      tenantId: 'beta', subjectUserId: 'reviewer-1', targetType: 'session', targetId: 'session-1', scope: 'qa_read', at: CHECKED_AT,
    })).resolves.toBe(false);
    await expect(store.authorize({
      tenantId: 'acme', subjectUserId: 'reviewer-1', targetType: 'session', targetId: 'session-other', scope: 'qa_read', at: CHECKED_AT,
    })).resolves.toBe(false);
    await expect(store.authorize({
      tenantId: 'acme', subjectUserId: 'reviewer-1', targetType: 'session', targetId: 'session-1', scope: 'guardrail_read', at: CHECKED_AT,
    })).resolves.toBe(false);

    grants.get(active.grantId)!.status = 'revoked';
    await expect(store.authorize({
      tenantId: 'acme', subjectUserId: 'reviewer-1', targetType: 'session', targetId: 'session-1', scope: 'qa_read', at: CHECKED_AT,
    })).resolves.toBe(false);
    grants.get(active.grantId)!.status = 'active';
    grants.get(active.grantId)!.expires_at = '2026-08-08T23:59:59.999Z';
    await expect(store.authorize({
      tenantId: 'acme', subjectUserId: 'reviewer-1', targetType: 'session', targetId: 'session-1', scope: 'qa_read', at: CHECKED_AT,
    })).resolves.toBe(false);
  });

  it('authorize 对非法 scope fail closed，PG 故障不会误授权', async () => {
    const { pool } = buildPool();
    const store = new PgContentAccessGrantStore({ pool, tablePrefix: 'test' });
    await expect(store.authorize({
      tenantId: 'acme', subjectUserId: 'reviewer-1', targetType: 'session', targetId: 'session-1', scope: 'admin' as ContentAccessGrantScope,
    })).resolves.toBe(false);

    const failedStore = new PgContentAccessGrantStore({
      pool: { query: async () => { throw new Error('pg down'); } } as never,
      tablePrefix: 'test',
    });
    await expect(failedStore.authorize({
      tenantId: 'acme', subjectUserId: 'reviewer-1', targetType: 'session', targetId: 'session-1', scope: 'qa_read', at: CHECKED_AT,
    })).rejects.toThrow('pg down');
  });

  it('revoke 只变更状态、revision 与 revokedBy，Grant ID 保持不变', async () => {
    const { pool } = buildPool();
    const store = new PgContentAccessGrantStore({ pool, tablePrefix: 'test' });
    const created = await store.create(createInput);

    const revoked = await store.revoke({
      tenantId: 'acme', grantId: created.grantId, expectedRevision: 1, revokedBy: 'security-admin-2',
    });

    expect(revoked).toMatchObject({
      grantId: created.grantId, status: 'revoked', revision: 2, revokedBy: 'security-admin-2',
      createdBy: 'security-admin',
    });
    await expect(store.revoke({
      tenantId: 'acme', grantId: created.grantId, expectedRevision: 1, revokedBy: 'security-admin-2',
    })).rejects.toMatchObject({ code: 'CONTENT_ACCESS_GRANT_VERSION_CONFLICT' });
  });

  it('create 拒绝空字段、未知 scope 与已过期 Grant', async () => {
    const { pool } = buildPool();
    const store = new PgContentAccessGrantStore({ pool, tablePrefix: 'test' });
    await expect(store.create({ ...createInput, purpose: '' }))
      .rejects.toMatchObject({ code: 'CONTENT_ACCESS_GRANT_INVALID' });
    await expect(store.create({ ...createInput, scopes: ['admin' as ContentAccessGrantScope] }))
      .rejects.toMatchObject({ code: 'CONTENT_ACCESS_GRANT_INVALID' });
    await expect(store.create({ ...createInput, expiresAt: '2020-01-01T00:00:00.000Z' }))
      .rejects.toMatchObject({ code: 'CONTENT_ACCESS_GRANT_INVALID' });
  });
});
