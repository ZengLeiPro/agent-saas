/**
 * QaConsole hooks 测试（计划用例 10-11）
 *
 * 10. 切换 orgAgentId 过滤 → 先清空旧数据再拉取（请求期间不显示旧过滤器数据）
 * 11. 503 → availability='unavailable'（file backend 未装配 PG，前端隐藏换提示）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useQaSessions } from './hooks';
import type { QaSessionItem } from './types';

const authFetchMock = vi.fn();
vi.mock('@/lib/authFetch', () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
  setOnUnauthorized: vi.fn(),
}));

function sessionItem(sessionId: string, orgAgentId: string): QaSessionItem {
  return {
    sessionId,
    title: `会话 ${sessionId}`,
    userId: 'u-1',
    username: 'emp',
    orgAgentId,
    orgAgentName: 'Agent',
    orgAgentAvatar: null,
    createdAt: '2026-07-10T07:00:00.000Z',
    updatedAt: '2026-07-10T08:00:00.000Z',
    runtimeStatus: 'completed',
    totalCostUsd: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('useQaSessions', () => {
  beforeEach(() => {
    authFetchMock.mockReset();
  });

  it('用例10: 切换 orgAgentId 过滤先清空旧数据', async () => {
    // 第一轮：agent-1 的两条会话
    authFetchMock.mockResolvedValueOnce(jsonResponse({
      items: [sessionItem('s-1', 'oa-1'), sessionItem('s-2', 'oa-1')],
    }));

    const { result, rerender } = renderHook(
      ({ orgAgentId }: { orgAgentId?: string }) => useQaSessions({ tenantId: 'tenant-a', orgAgentId }),
      { initialProps: { orgAgentId: 'oa-1' as string | undefined } },
    );

    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.availability).toBe('available');

    // 第二轮：切到 oa-2，响应挂起（pending promise）——此窗口内旧数据必须已被清空
    let resolveSecond: (res: Response) => void;
    authFetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveSecond = resolve; }));

    rerender({ orgAgentId: 'oa-2' });

    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.items).toHaveLength(0); // 旧过滤器数据已清空

    await act(async () => {
      resolveSecond!(jsonResponse({ items: [sessionItem('s-9', 'oa-2')] }));
    });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0].sessionId).toBe('s-9');

    // 请求参数确实带了新过滤器
    const lastUrl = String(authFetchMock.mock.calls.at(-1)?.[0]);
    expect(lastUrl).toContain('orgAgentId=oa-2');
  });

  it('用例11: 503 → availability=unavailable', async () => {
    authFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not configured' }), { status: 503 }));
    const { result } = renderHook(() => useQaSessions({ tenantId: 'tenant-a' }));
    await waitFor(() => expect(result.current.availability).toBe('unavailable'));
    expect(result.current.items).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });
});
