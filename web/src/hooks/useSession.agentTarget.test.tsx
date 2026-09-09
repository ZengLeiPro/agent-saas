import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyReplayedSessionMetadata, type AgentTarget, type BoundaryIdentity } from '@agent/shared';
import { sessionAgentTargetPresentation } from '@/lib/sessionAgentTargetIdentity';
import { getDesktopHeaderTitle } from '@/layouts/desktopHeaderTitle';
import type { LayoutProps } from '@/layouts/types';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/authFetch', () => ({ authFetch: fetchMock }));
vi.mock('@/lib/preload', () => ({ sessionsPreload: Promise.resolve({ sessions: [], hasMore: false }) }));
vi.mock('@/lib/sessionListCache', () => ({ loadSessionListCache: () => null, saveSessionListCache: vi.fn() }));
vi.mock('@/lib/messageCache', () => ({
  loadSessionMessageSnapshot: vi.fn().mockResolvedValue(null), saveSessionMessages: vi.fn(),
  clearSessionMessages: vi.fn().mockResolvedValue(undefined),
}));

import { useSession } from './useSession';

const identity = { tenantId: 't1', userId: 'u1', generation: 1 } as BoundaryIdentity;
const personal: AgentTarget = { kind: 'personal', tenantId: 't1' };
const expert: AgentTarget = { kind: 'org-agent', tenantId: 't1', orgAgentId: 'expert-1' };
const callbacks = () => ({ resetMessages: vi.fn(), setMessages: vi.fn(), triggerScroll: vi.fn(), cancelActiveStream: vi.fn() });
const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const detail = (target: AgentTarget = personal) => ({
  sessionId: 'new-session', agentTarget: target, agentTargetBindingVersion: 1,
  agentTargetSnapshot: { name: target.kind === 'personal' ? '个人 Agent' : '订单专家', status: 'available' as const, version: 1 },
});
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}
function header(session: ReturnType<typeof useSession>['sessions'][number]) {
  return getDesktopHeaderTitle({
    activeTab: 'chat', isTrashPreview: false, sessionId: session.sessionId,
    sidebarSessions: [{ ...session, id: session.sessionId, title: session.title ?? '新会话', createdAt: 1, updatedAt: 1 }] as LayoutProps['sidebarSessions'],
    activeAgentTargetLabel: sessionAgentTargetPresentation(session).label,
    activeOrgAgent: null, orgAgentIdentityLoading: false, agentProfile: null,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({ sessions: [], hasMore: false }));
});

describe('new-session authoritative Agent identity integration', () => {
  it.each([personal, expert])('fills an ID-only local row without waiting for the list projection: $kind', async (target) => {
    const pending = deferred();
    fetchMock.mockImplementation((url: string) => url === '/api/sessions/new-session?limit=1'
      ? pending.promise : Promise.resolve(json({ sessions: [], hasMore: false })));
    const cb = callbacks();
    const { result } = renderHook(() => useSession(cb, { identity }));
    await act(async () => { await Promise.resolve(); });
    act(() => {
      result.current.setSessionId('new-session');
      result.current.upsertSession({ sessionId: 'new-session', updatedAtMs: 10, title: '新会话' });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/sessions/new-session?limit=1', expect.objectContaining({ signal: expect.any(AbortSignal) })));
    expect(header(result.current.sessions[0]!)).not.toContain('绑定不可验证');
    expect(sessionAgentTargetPresentation(result.current.sessions[0]).unavailableReason?.code).toBe('session_binding_pending');
    await act(async () => { await result.current.refreshSessions(); });
    expect(result.current.sessions).toHaveLength(1);
    await act(async () => { pending.resolve(json(detail(target))); });
    await waitFor(() => expect(result.current.sessions[0]?.agentTarget).toEqual(target));
    expect(header(result.current.sessions[0]!)).toBe(target.kind === 'personal' ? '新会话' : '新会话 · 订单专家');
    expect(sessionAgentTargetPresentation(result.current.sessions[0]).unavailableReason).toBeUndefined();
    expect(result.current.sessionId).toBe('new-session');
    expect(cb.setMessages).not.toHaveBeenCalled();
  });

  it('keeps canonical metadata through upsert and later partial WS updates', async () => {
    const { result } = renderHook(() => useSession(callbacks(), { identity }));
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.upsertSession({ ...detail(expert), updatedAtMs: 1, title: '订单' }));
    expect(result.current.sessions[0]?.agentTargetSnapshot).toEqual(detail(expert).agentTargetSnapshot);
    act(() => result.current.upsertSession({ sessionId: 'new-session', updatedAtMs: 2, preview: '新消息', agentTarget: undefined }));
    expect(result.current.sessions[0]?.agentTarget).toEqual(expert);
    expect(result.current.sessions[0]?.agentTargetBindingVersion).toBe(1);
    expect(result.current.sessions[0]?.agentTargetSnapshot?.name).toBe('订单专家');
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/sessions/new-session?limit=1')).toHaveLength(0);
  });

  it('hydrates a cross-device session_updated replay through the same path', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(json(url === '/api/sessions/new-session?limit=1'
      ? detail(expert) : { sessions: [], hasMore: false })));
    const { result } = renderHook(() => useSession(callbacks(), { identity }));
    await act(async () => { await Promise.resolve(); });
    act(() => { applyReplayedSessionMetadata(result.current, {
      type: 'session_updated', sessionId: 'new-session', updatedAtMs: 4, title: '另一台设备的会话', isNew: true,
    }); });
    await waitFor(() => expect(result.current.sessions[0]?.agentTarget).toEqual(expert));
    expect(result.current.sessions[0]?.title).toBe('另一台设备的会话');
    expect(result.current.sessionId).toBeNull();
  });

  it('retains genuine server-unproven state and its read-only reason', async () => {
    const reason = { code: 'legacy_binding_unproven', message: '历史会话仅可查看', contactAdmin: true } as const;
    fetchMock.mockImplementation((url: string) => Promise.resolve(json(url === '/api/sessions/new-session?limit=1'
      ? { sessionId: 'new-session', agentTargetUnavailableReason: reason } : { sessions: [], hasMore: false })));
    const { result } = renderHook(() => useSession(callbacks(), { identity }));
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.upsertSession({ sessionId: 'new-session', updatedAtMs: 1 }));
    await waitFor(() => expect(result.current.sessions[0]?.agentTargetUnavailableReason).toEqual(reason));
    expect(header(result.current.sessions[0]!)).toBe('新会话 · 绑定不可验证');
    expect(result.current.sessions[0]?.agentTarget).toBeUndefined();
  });

  it('does not misclassify an authorization/network failure as a historical binding failure', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(url === '/api/sessions/new-session?limit=1'
      ? json({}, 403) : json({ sessions: [], hasMore: false })));
    const { result } = renderHook(() => useSession(callbacks(), { identity }));
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.upsertSession({ sessionId: 'new-session', updatedAtMs: 1 }));
    await waitFor(() => expect(result.current.sessions[0]?.agentTargetUnavailableReason?.code).toBe('session_binding_pending'));
    expect(header(result.current.sessions[0]!)).toBe('新会话 · 身份待确认');
    expect(result.current.sessions[0]?.agentTarget).toBeUndefined();
  });

  it('does not revive a deleted row or change the draft view after an in-flight read', async () => {
    const pending = deferred();
    fetchMock.mockImplementation((url: string) => url === '/api/sessions/new-session?limit=1'
      ? pending.promise : Promise.resolve(json({ sessions: [], hasMore: false })));
    const cb = callbacks();
    const { result } = renderHook(() => useSession(cb, { identity }));
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.upsertSession({ sessionId: 'new-session', updatedAtMs: 1 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/sessions/new-session?limit=1', expect.anything()));
    act(() => result.current.removeSession('new-session'));
    await act(async () => { pending.resolve(json(detail())); });
    expect(result.current.sessions).toEqual([]);
    expect(result.current.sessionId).toBeNull();
    expect(cb.setMessages).not.toHaveBeenCalled();
  });

  it('ignores an older detail read after a fresh list has confirmed revocation', async () => {
    const pending = deferred();
    const revoked = { ...detail(expert), updatedAtMs: 20, agentTargetSnapshot: { name: '订单专家', status: 'revoked', version: 3 },
      agentTargetUnavailableReason: { code: 'org_agent_unassigned', message: '权限已撤销', contactAdmin: true },
    };
    let fresh = false;
    fetchMock.mockImplementation((url: string) => url === '/api/sessions/new-session?limit=1'
      ? pending.promise : Promise.resolve(json({ sessions: fresh ? [revoked] : [], hasMore: false })));
    const { result } = renderHook(() => useSession(callbacks(), { identity }));
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.upsertSession({ sessionId: 'new-session', updatedAtMs: 1 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/sessions/new-session?limit=1', expect.anything()));
    fresh = true;
    await act(async () => { await result.current.refreshSessions(); });
    await act(async () => { pending.resolve(json(detail(expert))); });
    expect(result.current.sessions[0]?.agentTargetSnapshot?.version).toBe(3);
    expect(result.current.sessions[0]?.agentTargetUnavailableReason?.code).toBe('org_agent_unassigned');
  });

  it('fences late replies when the authentication generation changes', async () => {
    const old = deferred();
    const next = deferred();
    let reads = 0;
    fetchMock.mockImplementation((url: string) => url === '/api/sessions/new-session?limit=1'
      ? (++reads === 1 ? old.promise : next.promise) : Promise.resolve(json({ sessions: [], hasMore: false })));
    const cb = callbacks();
    const { result, rerender } = renderHook(({ auth }) => useSession(cb, { identity: auth }), { initialProps: { auth: identity } });
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.upsertSession({ sessionId: 'new-session', updatedAtMs: 1 }));
    await waitFor(() => expect(reads).toBe(1));
    const oldInit = fetchMock.mock.calls.find(([url]) => url === '/api/sessions/new-session?limit=1')![1] as RequestInit;
    rerender({ auth: { ...identity, generation: 2 } });
    await waitFor(() => expect(reads).toBe(2));
    expect(oldInit.signal?.aborted).toBe(true);
    await act(async () => { next.resolve(json(detail(expert))); });
    await waitFor(() => expect(result.current.sessions[0]?.agentTarget).toEqual(expert));
    await act(async () => { old.resolve(json(detail(personal))); });
    expect(result.current.sessions[0]?.agentTarget).toEqual(expert);
  });

  it('aborts identity reads on unmount', async () => {
    const pending = deferred();
    fetchMock.mockImplementation((url: string) => url === '/api/sessions/new-session?limit=1'
      ? pending.promise : Promise.resolve(json({ sessions: [], hasMore: false })));
    const { result, unmount } = renderHook(() => useSession(callbacks(), { identity }));
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.upsertSession({ sessionId: 'new-session', updatedAtMs: 1 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/sessions/new-session?limit=1', expect.anything()));
    const init = fetchMock.mock.calls.find(([url]) => url === '/api/sessions/new-session?limit=1')![1] as RequestInit;
    unmount();
    expect(init.signal?.aborted).toBe(true);
    pending.resolve(json(detail()));
  });
});
