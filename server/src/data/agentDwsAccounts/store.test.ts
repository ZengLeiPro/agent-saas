import { describe, expect, it, vi } from 'vitest';

import { PgAgentDwsAccountStore } from './store.js';

function row(eventPolicy: unknown) {
  return {
    account_id: 'account-a', tenant_id: 'tenant-a', agent_id: 'agent-a',
    display_name: '销售 Agent', login_id: 'login-a', status: 'active', runtime_status: 'ready',
    event_policy_json: eventPolicy, revision: 4,
    created_at: '2026-08-22T00:00:00.000Z', created_by: 'admin-a',
    identity_updated_at: '2026-08-22T00:30:00.000Z',
    updated_at: '2026-08-22T01:00:00.000Z', updated_by: 'admin-b',
  };
}

describe('PgAgentDwsAccountStore identity and lease fencing', () => {
  it('CAS writes only contextPolicy with jsonb_set so event kinds remain intact', async () => {
    const policy = {
      historical: { mode: 'selected' as const, conversationIds: ['cid-a'], lookbackDays: 30 },
      realtime: { mode: 'all' as const, conversationIds: [] },
    };
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [row({ kinds: ['at_me'], contextPolicy: policy })],
    }));
    const store = new PgAgentDwsAccountStore({ query } as never, 'test');

    const result = await store.setContextPolicy('tenant-a', 'account-a', policy, 3, 'admin-b');

    expect(query.mock.calls[0]![0]).toContain("jsonb_set");
    expect(query.mock.calls[0]![0]).toContain("'{contextPolicy}'");
    const params = query.mock.calls[0]![1] as unknown[];
    expect(params.slice(0, 3)).toEqual(['tenant-a', 'account-a', 3]);
    expect(params[4]).toBe('admin-b');
    expect(JSON.parse(String(params[3]))).toMatchObject({
      ...policy,
      effectiveAt: expect.stringMatching(/^20\d{2}-\d{2}-\d{2}T/),
    });
    expect(result).toMatchObject({ eventKinds: ['at_me'], contextPolicy: policy, revision: 4 });
  });

  it('maps missing or malformed policy fail-closed', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [row({ kinds: ['all_direct'] })] }));
    const store = new PgAgentDwsAccountStore({ query } as never, 'test');
    const missing = await store.getForTenant('tenant-a', 'account-a');
    expect(missing?.contextPolicy).toEqual({
      historical: { mode: 'none', conversationIds: [], lookbackDays: 30 },
      realtime: { mode: 'none', conversationIds: [] },
      wiki: { enabled: false },
      minutes: { enabled: false, lookbackDays: 30 },
    });

    query.mockResolvedValueOnce({
      rows: [row({
        kinds: ['all_direct'],
        contextPolicy: {
          historical: { mode: 'all', conversationIds: ['must-be-empty'], lookbackDays: 30 },
          realtime: { mode: 'all', conversationIds: [] },
        },
      })],
    });
    const malformed = await store.getForTenant('tenant-a', 'account-a');
    expect(malformed?.contextPolicy?.historical.mode).toBe('none');
    expect(malformed?.contextPolicy?.realtime.mode).toBe('none');
  });

  it('运行时租约、状态与事件均按账号 revision fencing，拒绝旧快照', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    const store = new PgAgentDwsAccountStore({ query } as never, 'test');

    await expect(store.claimRuntimeLease('account-a', 'worker-a', 60_000, 7)).resolves.toBe(false);
    expect(query.mock.calls[0]![0]).toContain('account_id=$1 AND revision=$4');
    expect(query.mock.calls[0]![1]).toEqual(['account-a', 'worker-a', 60_000, 7]);

    await expect(store.renewRuntimeLease('account-a', 'worker-a', 60_000, 7)).resolves.toBe(false);
    expect(query.mock.calls[1]![0]).toContain('account_id=$1 AND revision=$4');
    expect(query.mock.calls[1]![1]).toEqual(['account-a', 'worker-a', 60_000, 7]);

    await store.updateRuntimeStatus('account-a', 'starting', undefined, 'worker-a', 7);
    expect(query.mock.calls[2]![0]).toContain('account_id=$1 AND revision=$5');
    expect(query.mock.calls[2]![1]).toEqual(['account-a', 'starting', null, 'worker-a', 7]);

    const occurredAt = new Date('2026-08-30T00:00:00.000Z');
    await expect(store.markEvent('account-a', 'worker-a', occurredAt, 7)).resolves.toBe(false);
    expect(query.mock.calls[3]![0]).toContain('account_id=$1 AND revision=$4');
    expect(query.mock.calls[3]![1]).toEqual(['account-a', 'worker-a', occurredAt.toISOString(), 7]);
  });

  it('授权时分别持久化精确 selector 与 corpId，并拒绝组织级 selector', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [row({ kinds: ['at_me'] })],
    }));
    const store = new PgAgentDwsAccountStore({ query } as never, 'test');

    await store.markAuthorized('tenant-a', 'account-a', 3, {
      profileId: 'corp-a:user-a',
      corpId: 'corp-a',
      corpName: '示例企业',
      dingtalkUserId: 'user-a',
      dingtalkUserName: '张三',
    }, 'admin-b');

    expect(query.mock.calls[0]![0]).toContain('SET profile_id=$4,corp_id=$5,corp_name=$6');
    expect(query.mock.calls[0]![0]).toContain('identity_updated_at=CASE');
    expect(query.mock.calls[0]![0]).toContain('profile_id IS DISTINCT FROM $4');
    expect(query.mock.calls[0]![0]).toContain('corp_id IS DISTINCT FROM $5');
    expect(query.mock.calls[0]![0]).toContain('dingtalk_user_id IS DISTINCT FROM $7');
    expect(query.mock.calls[0]![0]).toContain('ELSE identity_updated_at');
    expect(query.mock.calls[0]![0]).not.toContain('COALESCE(corp_id');
    expect(await store.getForTenant('tenant-a', 'account-a')).toMatchObject({
      identityUpdatedAt: '2026-08-22T00:30:00.000Z',
    });
    expect(query.mock.calls[0]![1]).toEqual([
      'tenant-a', 'account-a', 3, 'corp-a:user-a', 'corp-a', '示例企业', 'user-a', '张三', 'admin-b',
    ]);

    query.mockClear();
    await expect(store.markAuthorized('tenant-a', 'account-a', 3, {
      profileId: 'corp-a',
      corpId: 'corp-a',
      dingtalkUserId: 'user-a',
    }, 'admin-b')).rejects.toMatchObject({ code: 'AGENT_DWS_ACCOUNT_NOT_AUTHORIZED' });
    expect(query).not.toHaveBeenCalled();
  });
});
