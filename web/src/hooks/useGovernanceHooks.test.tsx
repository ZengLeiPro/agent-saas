import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { governanceFixture } from '@/components/Governance/testFixtures';
import type { GovernanceDomain } from '@agent/shared/types/governance';

import { useAccessEvaluation } from './useAccessEvaluation';
import { useEffectiveResources } from './useEffectiveResources';

const apiMocks = vi.hoisted(() => ({
  fetchEffectiveResources: vi.fn(),
  evaluateAccess: vi.fn(),
}));

vi.mock('../../../shared/src/lib/governanceApi', () => ({
  fetchEffectiveResources: apiMocks.fetchEffectiveResources,
  evaluateAccess: apiMocks.evaluateAccess,
}));

describe('治理数据 hooks', () => {
  beforeEach(() => {
    apiMocks.fetchEffectiveResources.mockReset();
    apiMocks.evaluateAccess.mockReset();
  });

  it('503 时清除旧结论并支持 retry，保持 fail closed', async () => {
    apiMocks.fetchEffectiveResources
      .mockRejectedValueOnce(Object.assign(new Error('service unavailable'), { status: 503 }))
      .mockResolvedValueOnce([governanceFixture()]);

    const { result } = renderHook(() => useEffectiveResources(['skill']));
    await waitFor(() => expect(result.current.error?.message).toBe('service unavailable'));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);

    await act(async () => { await result.current.retry(); });
    expect(result.current.error).toBeNull();
    expect(result.current.data).toHaveLength(1);
  });

  it('请求竞态中只接受最新资源域响应', async () => {
    let resolveSkill!: (value: ReturnType<typeof governanceFixture>[]) => void;
    let resolveAgent!: (value: ReturnType<typeof governanceFixture>[]) => void;
    apiMocks.fetchEffectiveResources
      .mockReturnValueOnce(new Promise((resolve) => { resolveSkill = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveAgent = resolve; }));

    const { result, rerender } = renderHook(
      ({ domain }) => useEffectiveResources([domain]),
      { initialProps: { domain: 'skill' as GovernanceDomain } },
    );
    rerender({ domain: 'agent' });

    const latest = governanceFixture({ domain: 'agent', primaryLabel: '最新 Agent 结论' });
    await act(async () => { resolveAgent([latest]); });
    await waitFor(() => expect(result.current.data?.[0]?.primaryResult.label).toBe('最新 Agent 结论'));

    const stale = governanceFixture({ primaryLabel: '迟到技能结论' });
    await act(async () => { resolveSkill([stale]); });
    expect(result.current.data?.[0]?.primaryResult.label).toBe('最新 Agent 结论');
  });

  it('access evaluation 仅透传命令给权威 API，并支持 disabled', async () => {
    apiMocks.evaluateAccess.mockResolvedValueOnce([governanceFixture()]);
    const command = { action: 'execute', resourceType: 'skill', resourceId: 's-1' };
    const { result, rerender } = renderHook(
      ({ value }) => useAccessEvaluation(value),
      { initialProps: { value: command as Record<string, unknown> | null } },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(apiMocks.evaluateAccess).toHaveBeenCalledWith(command);

    rerender({ value: null });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
  });
});
