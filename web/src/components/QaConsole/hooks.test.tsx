/**
 * QaConsole hooks 测试（计划用例 10-11 + 12-14 门禁看板派生）
 *
 * 10. 切换 orgAgentId 过滤 → 先清空旧数据再拉取（请求期间不显示旧过滤器数据）
 * 11. 503 → availability='unavailable'（file backend 未装配 PG，前端隐藏换提示）
 * 12. useQaGuardrailBoard：mode='shadow' 过滤只保留 `_shadow` 后缀事件（前端派生，不触发新请求）
 * 13. useQaGuardrailBoard：派生 topRejections + latency 分位数 + fallback 命中率
 * 14. useQaAppeals：404 → availability='unavailable'（申诉端点未部署时降级提示）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useQaAppeals, useQaGuardrailBoard, useQaSessions } from './hooks';
import type { QaGuardrailEvent, QaGuardrailMode, QaSessionItem } from './types';

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

function guardrailEvent(
  id: string,
  verdict: QaGuardrailEvent['verdict'],
  overrides: Partial<QaGuardrailEvent> = {},
): QaGuardrailEvent {
  return {
    id,
    tenantId: 'tenant-a',
    orgAgentId: 'oa-1',
    verdict,
    messageText: '帮我写周报',
    createdAt: '2026-07-10T08:00:00.000Z',
    model: 'doubao-1.5-lite',
    latencyMs: 500,
    ...overrides,
  };
}

describe('useQaGuardrailBoard', () => {
  beforeEach(() => {
    authFetchMock.mockReset();
  });

  it('用例12: mode 切换在前端过滤，不重复请求', async () => {
    const events: QaGuardrailEvent[] = [
      guardrailEvent('e-1', 'off_topic'),
      guardrailEvent('e-2', 'off_topic_shadow'),
      guardrailEvent('e-3', 'pass_flagged_shadow'),
      guardrailEvent('e-4', 'pass_flagged'),
    ];
    authFetchMock.mockResolvedValueOnce(jsonResponse({ events, total: 4 }));

    const { result, rerender } = renderHook(
      ({ mode }: { mode: QaGuardrailMode }) =>
        useQaGuardrailBoard({ tenantId: 'tenant-a', mode }),
      { initialProps: { mode: 'all' as QaGuardrailMode } },
    );

    await waitFor(() => expect(result.current.board.total).toBe(4));
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    rerender({ mode: 'shadow' });
    await waitFor(() => expect(result.current.board.total).toBe(2));
    expect(authFetchMock).toHaveBeenCalledTimes(1); // 未触发新请求
    expect(result.current.board.offTopicCount).toBe(1); // 只有 off_topic_shadow

    rerender({ mode: 'enforce' });
    await waitFor(() => expect(result.current.board.total).toBe(2));
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.board.offTopicCount).toBe(1); // 只有 off_topic
  });

  it('用例13: 派生 topRejections + latency P50 + fallback 命中率', async () => {
    const events: QaGuardrailEvent[] = [
      // 「帮我写周报」拒 3 次
      guardrailEvent('e-1', 'off_topic', { messageText: '帮我写周报', model: 'doubao-1.5-lite', latencyMs: 100 }),
      guardrailEvent('e-2', 'off_topic', { messageText: '帮我写周报', model: 'doubao-1.5-lite', latencyMs: 200 }),
      guardrailEvent('e-3', 'off_topic', { messageText: '帮我写周报', model: 'gpt-4o-mini', latencyMs: 300 }),
      // 「查客户情报」拒 1 次
      guardrailEvent('e-4', 'off_topic', { messageText: '查厦门唯恩电气情报', model: 'doubao-1.5-lite', latencyMs: 400 }),
      // 打标 1 次
      guardrailEvent('e-5', 'pass_flagged', { messageText: '帮我审报价单', model: 'glm-4-flash', latencyMs: 500 }),
    ];
    authFetchMock.mockResolvedValueOnce(jsonResponse({ events, total: 5 }));
    const { result } = renderHook(() => useQaGuardrailBoard({ tenantId: 'tenant-a', mode: 'all' }));
    await waitFor(() => expect(result.current.board.total).toBe(5));

    // topRejections：桶 1 = 「帮我写周报」count=3
    expect(result.current.board.topRejections[0].bucket).toBe('帮我写周报');
    expect(result.current.board.topRejections[0].count).toBe(3);
    expect(result.current.board.topRejections[0].offTopic).toBe(3);

    // latency 分位数：samples=5 排序后 [100,200,300,400,500]，P50=index2=300
    expect(result.current.board.latency.samples).toBe(5);
    expect(result.current.board.latency.p50).toBe(300);

    // model 分布：主档 doubao-1.5-lite=3，fallback = 2/5 = 40%
    expect(result.current.board.modelBreakdown[0].model).toBe('doubao-1.5-lite');
    expect(result.current.board.modelBreakdown[0].count).toBe(3);
    expect(result.current.board.fallbackHitRate).toBeCloseTo(0.4, 2);
  });
});

describe('useQaAppeals', () => {
  beforeEach(() => {
    authFetchMock.mockReset();
  });

  it('用例14: 404 → availability=unavailable（申诉端点未装配时降级）', async () => {
    authFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    const { result } = renderHook(() => useQaAppeals({ tenantId: 'tenant-a' }));
    await waitFor(() => expect(result.current.availability).toBe('unavailable'));
    expect(result.current.items).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });

  it('用例14b: pending 申诉排在前面（管理员优先处理）', async () => {
    authFetchMock.mockResolvedValueOnce(jsonResponse({
      items: [
        {
          id: 'a-1', tenantId: 'tenant-a', orgAgentId: 'oa-1',
          guardrailEventId: 'e-1', userId: 'u-1', reason: '',
          messageText: 'foo', verdict: 'off_topic',
          status: 'accepted', createdAt: '2026-07-10T08:00:00.000Z',
        },
        {
          id: 'a-2', tenantId: 'tenant-a', orgAgentId: 'oa-1',
          guardrailEventId: 'e-2', userId: 'u-2', reason: '',
          messageText: 'bar', verdict: 'off_topic',
          status: 'pending', createdAt: '2026-07-11T09:00:00.000Z',
        },
      ],
    }));
    const { result } = renderHook(() => useQaAppeals({ tenantId: 'tenant-a' }));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.items[0].status).toBe('pending');
    expect(result.current.items[0].id).toBe('a-2');
    // 避免 unused var 警告：断言 act 后续导入到位（保持 act 引用被使用）
    void act;
  });
});
