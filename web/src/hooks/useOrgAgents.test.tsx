import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useOrgAgents } from './useOrgAgents';

const authFetchMock = vi.fn();
let currentUser = { id: 'admin-id', tenantId: 'pantheon' };

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: currentUser }),
}));

vi.mock('@/lib/authFetch', () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

vi.mock('@/lib/refreshBus', () => ({
  registerRefresh: vi.fn(),
  unregisterRefresh: vi.fn(),
}));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function catalogResponse(tenantId: string, agentId = 'oa-1') {
  const personal = { kind: 'personal' as const, tenantId };
  const org = { kind: 'org-agent' as const, tenantId, orgAgentId: agentId };
  return {
    version: 1,
    tenantId,
    personal: { target: personal, availability: { status: 'available' as const } },
    orgAgents: [{ target: org, availability: { status: 'available' as const }, presentation: { id: agentId, name: '企业专家' } }],
    selectableTargets: [personal, org],
  };
}

describe('useOrgAgents', () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    currentUser = { id: 'admin-id', tenantId: 'pantheon' };
  });

  it('消费 tenant-scoped catalog，并拒绝 tenant mismatch', async () => {
    authFetchMock.mockResolvedValueOnce(jsonResponse(catalogResponse('pantheon')));
    const { result } = renderHook(() => useOrgAgents());
    await waitFor(() => expect(result.current.catalog?.tenantId).toBe('pantheon'));
    expect(result.current.agents).toEqual([{ id: 'oa-1', name: '企业专家' }]);

    authFetchMock.mockResolvedValueOnce(jsonResponse(catalogResponse('other-tenant')));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.catalog).toBeNull();
    expect(result.current.compatibilityReason?.code).toBe('tenant_mismatch');
  });

  it('切换账号时立即清空旧列表，并忽略旧账号迟到响应', async () => {
    authFetchMock.mockResolvedValueOnce(jsonResponse([
      { id: 'oa-admin', name: '管理员旧数据' },
    ]));

    const { result, rerender } = renderHook(() => useOrgAgents());
    await waitFor(() => expect(result.current.legacyAgents).toEqual([
      { id: 'oa-admin', name: '管理员旧数据' },
    ]));
    expect(result.current.agents).toEqual([]);

    let resolveOldRequest: (response: Response) => void;
    authFetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => {
      resolveOldRequest = resolve;
    }));
    await act(async () => {
      void result.current.refresh();
    });

    let resolveNewRequest: (response: Response) => void;
    authFetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => {
      resolveNewRequest = resolve;
    }));
    currentUser = { id: 'user-id', tenantId: 'kaiyan-demo' };
    rerender();

    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.agents).toEqual([]);
    expect(result.current.legacyAgents).toEqual([]);
    await act(async () => {
      resolveNewRequest!(jsonResponse([{ id: 'oa-user', name: '员工新数据' }]));
    });
    await waitFor(() => expect(result.current.legacyAgents).toEqual([
      { id: 'oa-user', name: '员工新数据' },
    ]));

    await act(async () => {
      resolveOldRequest!(jsonResponse([{ id: 'oa-stale', name: '迟到旧数据' }]));
    });
    expect(result.current.legacyAgents).toEqual([{ id: 'oa-user', name: '员工新数据' }]);
    expect(result.current.agents).toEqual([]);
  });
});
