import { describe, expect, it, vi } from 'vitest';

import { PgAgentDwsAccountStore } from './store.js';

function row(eventPolicy: unknown) {
  return {
    account_id: 'account-a', tenant_id: 'tenant-a', agent_id: 'agent-a',
    display_name: '销售 Agent', login_id: 'login-a', status: 'active', runtime_status: 'ready',
    event_policy_json: eventPolicy, revision: 4,
    created_at: '2026-08-22T00:00:00.000Z', created_by: 'admin-a',
    updated_at: '2026-08-22T01:00:00.000Z', updated_by: 'admin-b',
  };
}

describe('PgAgentDwsAccountStore context policy', () => {
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
});
