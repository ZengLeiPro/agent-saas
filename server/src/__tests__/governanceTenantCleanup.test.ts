import { describe, expect, it, vi } from 'vitest';

import { GovernanceTenantCleanup } from '../data/changeJobs/index.js';

describe('GovernanceTenantCleanup', () => {
  it('tenant_configuration 按真实 tenant_id 列清理并使用同一事务连接', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        queries.push(sql.replace(/\s+/g, ' ').trim());
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };
    const cleanup = new GovernanceTenantCleanup({
      pool: pool as never,
      tablePrefix: 'test',
      vault: { revokeSecret: vi.fn() } as never,
    });
    await cleanup.execute('acme', 'tenant_configuration');
    expect(queries[0]).toBe('BEGIN');
    expect(queries.at(-1)).toBe('COMMIT');
    expect(queries.filter(query => query.includes('entitlement_resource_'))).toEqual([
      'DELETE FROM test_entitlement_resource_items WHERE tenant_id=$1',
      'DELETE FROM test_entitlement_resource_scopes WHERE tenant_id=$1',
    ]);
    expect(queries.some(query => query.includes('set_id'))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('agents_skills 先删除 Agent DWS 账号再删除 managed agent', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql.replace(/\s+/g, ' ').trim());
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const cleanup = new GovernanceTenantCleanup({
      pool: { connect: vi.fn(async () => client) } as never,
      tablePrefix: 'test',
      vault: { revokeSecret: vi.fn() } as never,
    });

    await cleanup.execute('acme', 'agents_skills');
    const accountsIndex = queries.findIndex(query => query.startsWith('DELETE FROM test_agent_dws_accounts'));
    const agentsIndex = queries.findIndex(query => query.startsWith('DELETE FROM test_managed_agents'));
    const presentationsIndex = queries.findIndex(query => query.startsWith('DELETE FROM test_skill_presentations'));
    expect(accountsIndex).toBeGreaterThan(0);
    expect(presentationsIndex).toBeGreaterThan(0);
    expect(agentsIndex).toBeGreaterThan(accountsIndex);
  });

  it('credentials 先逐个撤销 Secret，再删除提交与凭据记录', async () => {
    const revokeSecret = vi.fn().mockResolvedValue(undefined);
    const pool = {
      connect: vi.fn(),
      query: vi.fn().mockResolvedValue({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [
          { credential_id: 'c1', secret_ref: 's1', owner_user_id: 'u1' },
          { credential_id: 'c2', secret_ref: 's2', owner_user_id: null },
        ] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const cleanup = new GovernanceTenantCleanup({
      pool: pool as never,
      tablePrefix: 'test',
      vault: { revokeSecret } as never,
    });
    await cleanup.execute('acme', 'credentials');
    expect(revokeSecret).toHaveBeenNthCalledWith(1, 's1', expect.objectContaining({ userId: 'u1', tenantId: 'acme' }));
    expect(revokeSecret).toHaveBeenNthCalledWith(2, 's2', expect.objectContaining({ tenantId: 'acme' }));
    expect(String(pool.query.mock.calls[1][0])).toContain('DELETE FROM test_credential_commits');
    expect(String(pool.query.mock.calls[2][0])).toContain('DELETE FROM test_credentials');
  });
});
