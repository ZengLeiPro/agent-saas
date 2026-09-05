// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ authFetch: vi.fn() }));

vi.mock('@agent/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/shared')>();
  return { ...actual, authFetch: h.authFetch };
});

import { useAgentTargetCatalog } from './useAgentTargetCatalog';

const user = { id: 'u1', tenantId: 't1' };

describe('mobile useAgentTargetCatalog', () => {
  beforeEach(() => {
    h.authFetch.mockReset();
  });

  it('无用户时不请求；有用户时拉目录，旧版数组响应判为 legacy 并保留原因', async () => {
    const { result, rerender } = renderHook(
      ({ current }: { current: typeof user | null }) => useAgentTargetCatalog(current),
      { initialProps: { current: null as typeof user | null } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.authFetch).not.toHaveBeenCalled();
    expect(result.current.agentTargetCatalogLoading).toBe(false);

    h.authFetch.mockResolvedValue({ ok: true, json: async () => [{ id: 'legacy' }] });
    rerender({ current: user });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.authFetch).toHaveBeenCalledWith('/api/org-agents/mine');
    expect(result.current.agentTargetCatalog).toBeNull();
    expect(result.current.agentTargetCatalogReason?.code).toBe('legacy_binding_unproven');
    expect(result.current.agentTargetCatalogLoading).toBe(false);
  });

  it('请求失败给出目录不可用原因；挂起目标同步进 ref 且用户切换时清空', async () => {
    h.authFetch.mockResolvedValue({ ok: false, json: async () => null });
    const { result, rerender } = renderHook(
      ({ current }: { current: typeof user }) => useAgentTargetCatalog(current),
      { initialProps: { current: user } },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.agentTargetCatalogReason).toMatchObject({
      code: 'target_catalog_unavailable',
      contactAdmin: true,
    });

    const target = { kind: 'personal' as const, tenantId: 't1' };
    act(() => {
      result.current.setPendingAgentTarget(target);
    });
    expect(result.current.pendingAgentTarget).toEqual(target);
    expect(result.current.pendingAgentTargetRef.current).toEqual(target);

    rerender({ current: { id: 'u2', tenantId: 't1' } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.pendingAgentTarget).toBeNull();
    expect(result.current.pendingAgentTargetRef.current).toBeNull();
  });
});
