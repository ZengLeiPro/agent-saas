import { useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSessionListItem, BoundaryIdentity } from '@agent/shared';
import { useSessionAgentTargetSync } from './useSessionAgentTargetSync';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/authFetch', () => ({ authFetch: fetchMock }));
const identity: BoundaryIdentity = { tenantId: 't1', userId: 'u1', generation: 1 };
const confirmed = {
  sessionId: 's1', agentTarget: { kind: 'personal', tenantId: 't1' }, agentTargetBindingVersion: 1,
  agentTargetSnapshot: { name: '个人 Agent', status: 'available', version: 1 },
};
const response = () => ({ ok: true, status: 200, json: async () => confirmed }) as Response;
function useHarness(auth: BoundaryIdentity | null) {
  const [sessions, setSessions] = useState<ApiSessionListItem[]>([{ sessionId: 's1', updatedAtMs: 1 }]);
  useSessionAgentTargetSync(sessions, setSessions, auth);
  return sessions;
}

beforeEach(() => { fetchMock.mockReset(); });

describe('session identity hydration requires an authenticated boundary', () => {
  it('does not read scope-free metadata while login identity is unresolved; starts when ready', async () => {
    fetchMock.mockResolvedValue(response());
    const { result, rerender } = renderHook(({ auth }: { auth: BoundaryIdentity | null }) => useHarness(auth), {
      initialProps: { auth: null as BoundaryIdentity | null },
    });
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current[0]?.agentTarget).toBeUndefined();
    rerender({ auth: identity });
    await waitFor(() => expect(result.current[0]?.agentTarget).toEqual(confirmed.agentTarget));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts and ignores a late authenticated reply after logout without starting anonymous reads', async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((done) => { resolve = done; }));
    const { result, rerender } = renderHook(({ auth }: { auth: BoundaryIdentity | null }) => useHarness(auth), {
      initialProps: { auth: identity as BoundaryIdentity | null },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    rerender({ auth: null });
    expect(init.signal?.aborted).toBe(true);
    await act(async () => { resolve(response()); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current[0]?.agentTarget).toBeUndefined();
  });
});
