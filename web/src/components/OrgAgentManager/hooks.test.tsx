import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAuthFetch } = vi.hoisted(() => ({ mockAuthFetch: vi.fn() }));

vi.mock('@/lib/authFetch', () => ({ authFetch: mockAuthFetch }));

import { useOrgAgentAdmin } from './hooks';

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function record(id: string, tenantId: string) {
  return {
    id,
    tenantId,
    name: `专家 ${id}`,
    description: '',
    starterPrompts: [],
    instructions: '',
    allowedSkills: [],
    audience: { exposure: 'all', usernames: [] },
    guardrail: {
      enabled: false,
      scopeDescription: '',
      rejectionMessage: '超出范围',
      strictness: 'strict',
    },
    enabled: true,
    createdAt: '2026-08-14T00:00:00.000Z',
    createdBy: 'admin',
    updatedAt: '2026-08-14T00:00:00.000Z',
    updatedBy: 'admin',
  };
}

beforeEach(() => mockAuthFetch.mockReset());

describe('useOrgAgentAdmin', () => {
  it('空资源列表正常结束加载', async () => {
    mockAuthFetch.mockResolvedValue(response([]));
    const { result } = renderHook(() => useOrgAgentAdmin('tenant-a'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.agents).toEqual([]);
    expect(result.current.dataIssues).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('请求失败保留明确错误，重试成功后恢复', async () => {
    mockAuthFetch
      .mockResolvedValueOnce(response({ error: '服务暂不可用' }, false))
      .mockResolvedValueOnce(response([record('oa-a', 'tenant-a')]));
    const { result } = renderHook(() => useOrgAgentAdmin('tenant-a'));

    await waitFor(() => expect(result.current.error).toBe('服务暂不可用'));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.error).toBeNull();
    expect(result.current.agents.map(agent => agent.id)).toEqual(['oa-a']);
  });

  it('组织切换时清空旧列表，并忽略前一组织的迟到响应', async () => {
    let resolveA!: (value: Response) => void;
    const requestA = new Promise<Response>((resolve) => { resolveA = resolve; });
    mockAuthFetch.mockImplementation((url?: string) => {
      if (url?.includes('tenant-a')) return requestA;
      return Promise.resolve(response([record('oa-b', 'tenant-b')]));
    });
    const { result, rerender } = renderHook(
      ({ tenantId }) => useOrgAgentAdmin(tenantId),
      { initialProps: { tenantId: 'tenant-a' } },
    );
    const staleRefresh = result.current.refresh;

    rerender({ tenantId: 'tenant-b' });
    await act(async () => { await staleRefresh(); });
    await waitFor(() => expect(result.current.agents.map(agent => agent.id)).toEqual(['oa-b']));

    await act(async () => { resolveA(response([record('oa-a', 'tenant-a')])); });
    expect(result.current.agents.map(agent => agent.id)).toEqual(['oa-b']);
    expect(mockAuthFetch).toHaveBeenCalledWith('/api/org-agents?tenantId=tenant-b');
    expect(mockAuthFetch.mock.calls.filter(([url]) => String(url).includes('tenant-a'))).toHaveLength(1);
  });
});
