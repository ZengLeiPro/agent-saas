import { describe, expect, it, vi } from 'vitest';

import { PgOAuthGrantStore } from '../data/oauthGrants/index.js';

const NOW = '2026-08-10T00:00:00.000Z';

function grantRow() {
  return {
    grant_id: 'grant-1', tenant_id: 'tenant-a', subject_user_id: 'user-1',
    provider: 'github', connector_id: 'github', status: 'active',
    scope_summary_json: ['repo:read'], approved_at: NOW, expires_at: null,
    last_used_at: null, version: 1,
  };
}

describe('PgOAuthGrantStore', () => {
  it('个人查询只返回 Grant 安全字段与批准历史', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM test_oauth_grants')) return { rows: [grantRow()], rowCount: 1 };
      return { rows: [{
        approval_id: 'approval-1', grant_id: 'grant-1', action: 'approved',
        scope_summary_json: ['repo:read'], purpose: 'repository automation',
        actor_user_id: 'user-1', occurred_at: NOW,
      }], rowCount: 1 };
    });
    const store = new PgOAuthGrantStore({ pool: { query } as never, tablePrefix: 'test' });
    const grants = await store.listForSubject('tenant-a', 'user-1');
    expect(grants).toEqual([expect.objectContaining({
      grantId: 'grant-1', provider: 'github', scopeSummary: ['repo:read'],
      approvals: [expect.objectContaining({ approvalId: 'approval-1', purpose: 'repository automation' })],
    })]);
    expect(JSON.stringify(grants)).not.toMatch(/token|secret|external.*account/i);
  });

  it('OAuth 回调投影与批准记录在同一事务提交', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO test_oauth_grants')) return { rows: [grantRow()], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const store = new PgOAuthGrantStore({ pool: { connect: vi.fn().mockResolvedValue(client) } as never, tablePrefix: 'test' });
    await expect(store.recordProjection({
      grantId: 'grant-1', tenantId: 'tenant-a', subjectUserId: 'user-1', provider: 'github',
      connectorId: 'github', status: 'active', scopeSummary: ['repo:read'], approvedAt: NOW,
      action: 'approved', purpose: 'repository automation', actorUserId: 'user-1',
    })).resolves.toMatchObject({ grantId: 'grant-1', status: 'active' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO test_oauth_approval_records'), expect.arrayContaining([
      expect.stringMatching(/^oar-/), 'grant-1', 'tenant-a', 'user-1', 'approved',
    ]));
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

  it('外部撤销前先将 Grant 持久化为 error，失败后可安全重试', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...grantRow(), status: 'error', version: 2 }], rowCount: 1 });
    const store = new PgOAuthGrantStore({ pool: { query } as never, tablePrefix: 'test' });
    await expect(store.markRevocationPending({
      grantId: 'grant-1', tenantId: 'tenant-a', subjectUserId: 'user-1',
    })).resolves.toMatchObject({ status: 'error', version: 2 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status IN ('active','error')"), ['grant-1', 'tenant-a', 'user-1', null, null]);
  });

  it('legacy reconciler 用 advisory lock 与确定性 approval id 幂等补投影', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM test_oauth_grants')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO test_oauth_grants')) return { rows: [grantRow()], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const store = new PgOAuthGrantStore({ pool: { connect: vi.fn().mockResolvedValue(client) } as never, tablePrefix: 'test' });
    await expect(store.ensureProjection({
      grantId: 'grant-1', tenantId: 'tenant-a', subjectUserId: 'user-1', provider: 'github',
      connectorId: 'github', status: 'active', scopeSummary: ['repo:read'], approvedAt: NOW,
      action: 'approved', purpose: 'legacy_backfill', actorUserId: 'user-1',
    })).resolves.toMatchObject({ grantId: 'grant-1' });
    expect(query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', ['oauth-grant:grant-1']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (approval_id) DO NOTHING'), expect.arrayContaining([
      expect.stringMatching(/^oar-ensure-/), 'grant-1',
    ]));
  });

  it('实际断开后幂等写入 revoked Grant 与撤销批准记录', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM test_oauth_grants')) return { rows: [grantRow()], rowCount: 1 };
      if (sql.includes('UPDATE test_oauth_grants')) return { rows: [{ ...grantRow(), status: 'revoked', version: 2 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() };
    const store = new PgOAuthGrantStore({ pool: { connect: vi.fn().mockResolvedValue(client) } as never, tablePrefix: 'test' });
    await expect(store.recordRevocation({
      grantId: 'grant-1', tenantId: 'tenant-a', subjectUserId: 'user-1',
      purpose: 'disconnect', actorUserId: 'user-1',
    })).resolves.toMatchObject({ grantId: 'grant-1', status: 'revoked', version: 2 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO test_oauth_approval_records'), expect.arrayContaining([
      expect.stringMatching(/^oar-/), 'grant-1', 'tenant-a', 'user-1',
    ]));
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

});
