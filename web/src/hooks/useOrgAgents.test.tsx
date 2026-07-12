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

describe('useOrgAgents', () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    currentUser = { id: 'admin-id', tenantId: 'pantheon' };
  });

  it('切换账号时立即清空旧列表，并忽略旧账号迟到响应', async () => {
    authFetchMock.mockResolvedValueOnce(jsonResponse([
      { id: 'oa-admin', name: '管理员旧数据' },
    ]));

    const { result, rerender } = renderHook(() => useOrgAgents());
    await waitFor(() => expect(result.current.agents).toEqual([
      { id: 'oa-admin', name: '管理员旧数据' },
    ]));

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
    await act(async () => {
      resolveNewRequest!(jsonResponse([{ id: 'oa-user', name: '员工新数据' }]));
    });
    await waitFor(() => expect(result.current.agents).toEqual([
      { id: 'oa-user', name: '员工新数据' },
    ]));

    await act(async () => {
      resolveOldRequest!(jsonResponse([{ id: 'oa-stale', name: '迟到旧数据' }]));
    });
    expect(result.current.agents).toEqual([{ id: 'oa-user', name: '员工新数据' }]);
  });
});
