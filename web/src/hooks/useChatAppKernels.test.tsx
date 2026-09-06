import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageItem, ModelList, WsEvent } from '@agent/shared';
import {
  applyReplayedSessionMetadata,
  markMessageBubbleFailed,
  useAgentProfile,
  useForkFromMessage,
  useModelSelection,
  useSessionParticipants,
  useStreamWatchdog,
} from '@agent/shared';

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

describe('useStreamWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('首次 60s、收到流事件后 45s；探活 active 则续期，否则收尾', async () => {
    let loading = true;
    const authFetch = vi.fn(async () => jsonResponse({ active: true }));
    const onExpired = vi.fn();
    const { result } = renderHook(() =>
      useStreamWatchdog({
        authFetch,
        isLoading: () => loading,
        getSessionId: () => 's1',
        onExpired,
      }),
    );
    act(() => {
      result.current.resetWatchdog();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });
    expect(authFetch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(authFetch).toHaveBeenCalledWith('/api/sessions/s1/stream-status');
    expect(onExpired).not.toHaveBeenCalled();

    // 续期后收到流事件 → 45s 档；服务端不再活跃 → 收尾一次
    authFetch.mockResolvedValue(jsonResponse({ active: false }));
    act(() => {
      result.current.touchWatchdog();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(44_000);
    });
    expect(authFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(onExpired).toHaveBeenCalledWith('s1');

    // loading 结束后不再安排
    loading = false;
    act(() => {
      result.current.resetWatchdog();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('过期判定命中时放弃收尾；clearWatchdog 取消计时并重置流事件时间', async () => {
    let stale = false;
    const authFetch = vi.fn(async () => jsonResponse({ active: false }));
    const onExpired = vi.fn();
    const { result } = renderHook(() =>
      useStreamWatchdog({
        authFetch,
        isLoading: () => true,
        getSessionId: () => 's1',
        onExpired,
        createStaleGuard: () => () => stale,
      }),
    );
    act(() => {
      result.current.touchWatchdog();
    });
    stale = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(onExpired).not.toHaveBeenCalled();

    stale = false;
    act(() => {
      result.current.resetWatchdog();
    });
    act(() => {
      result.current.clearWatchdog();
    });
    expect(result.current.lastStreamEventAtRef.current).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(onExpired).not.toHaveBeenCalled();
  });
});

describe('useModelSelection', () => {
  it('列表到达后按 selectOnLoad 决定选中；失败静默', async () => {
    const list: ModelList = {
      groups: [],
      default: 'g/m1',
      allowCrossGroupSwitch: true,
      showGroupNames: false,
      showContextTokens: true,
      allowContextTokenDetails: false,
    };
    const authFetch = vi.fn(async () => jsonResponse(list));
    const selectOnLoad = vi.fn((prev: string | null, data: ModelList) => prev || data.default);
    const { result } = renderHook(() => useModelSelection({ authFetch, selectOnLoad }));
    expect(result.current.modelList).toBeNull();
    await act(async () => {
      result.current.fetchModelList();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.modelList).toEqual(list);
    expect(result.current.selectedModel).toBe('g/m1');
    expect(result.current.selectedModelRef.current).toBe('g/m1');
    expect(selectOnLoad).toHaveBeenCalledWith(null, list);

    act(() => {
      result.current.setSelectedModel('g/m2');
    });
    authFetch.mockResolvedValueOnce(jsonResponse({}, false));
    await act(async () => {
      result.current.fetchModelList();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.selectedModel).toBe('g/m2');
  });
});

describe('useForkFromMessage', () => {
  it('只对 user 消息 fork；成功后交给 onForked 并返回新会话 id', async () => {
    const authFetch = vi.fn(async () =>
      jsonResponse({ newSessionId: 's2', forkMessage: '继续这个话题' }),
    );
    const onForked = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useForkFromMessage({ authFetch, getSourceSessionId: () => 's1', onForked }),
    );
    const userMessage = { id: 'm1', type: 'user', content: 'hi' } as MessageItem;
    expect(await result.current({ id: 't', type: 'text', content: 'x' } as MessageItem)).toBeNull();
    expect(await result.current(userMessage)).toBe('s2');
    expect(authFetch).toHaveBeenCalledWith(
      '/api/sessions/s1/fork',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ blockId: 'm1' }),
      }),
    );
    expect(onForked).toHaveBeenCalledWith('s2', '继续这个话题');

    authFetch.mockResolvedValueOnce(jsonResponse({}, false));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await result.current(userMessage)).toBeNull();
    expect(onForked).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});

describe('markMessageBubbleFailed / applyReplayedSessionMetadata', () => {
  it('按 clientMsgId 从尾部定位 user 气泡，缺省回退到下标', () => {
    const messages: MessageItem[] = [
      { id: 'a', type: 'user', content: '1', clientMsgId: 'c1', status: 'pending' } as MessageItem,
      { id: 'b', type: 'text', content: '回复' } as MessageItem,
      { id: 'c', type: 'user', content: '2', clientMsgId: 'c2', status: 'pending' } as MessageItem,
    ];
    const target = {
      messagesRef: { current: messages },
      updateMessageAt: vi.fn((index: number, updater: (m: MessageItem) => MessageItem) => {
        messages[index] = updater(messages[index]);
      }),
    };
    markMessageBubbleFailed(target, 'c1', -1, '超时');
    expect(messages[0]).toMatchObject({ status: 'failed', failedReason: '超时' });
    markMessageBubbleFailed(target, 'missing', 2, '网络');
    expect(messages[2]).toMatchObject({ status: 'failed', failedReason: '网络' });
    markMessageBubbleFailed(target, 'missing', -1, '忽略');
    expect(target.updateMessageAt).toHaveBeenCalledTimes(2);
  });

  it('title_updated / session_updated 写入列表，其他事件不处理', () => {
    const sink = {
      updateSessionTitle: vi.fn(),
      updateSessionMeta: vi.fn(),
      upsertSession: vi.fn(),
    };
    expect(
      applyReplayedSessionMetadata(sink, {
        type: 'title_updated',
        sessionId: 's1',
        title: 'T',
      } as WsEvent),
    ).toBe(true);
    expect(sink.updateSessionTitle).toHaveBeenCalledWith('s1', 'T');
    expect(
      applyReplayedSessionMetadata(sink, {
        type: 'session_updated',
        sessionId: 's2',
        updatedAtMs: 5,
        preview: 'p',
        isNew: true,
        title: 'N',
      } as WsEvent),
    ).toBe(true);
    expect(sink.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's2', preview: 'p', updatedAtMs: 5, title: 'N' }),
    );
    expect(
      applyReplayedSessionMetadata(sink, {
        type: 'session_updated',
        sessionId: 's1',
        updatedAtMs: 6,
        preview: 'q',
      } as WsEvent),
    ).toBe(true);
    expect(sink.updateSessionMeta).toHaveBeenCalledWith('s1', { preview: 'q', updatedAtMs: 6 });
    expect(
      applyReplayedSessionMetadata(sink, { type: 'session_deleted', sessionId: 's1' } as WsEvent),
    ).toBe(false);
  });
});

describe('useAgentProfile / useSessionParticipants', () => {
  it('username 为空清空；owner 是自己时不加载参与者，是他人时先给 owner 再补 agent', async () => {
    const profile = { username: 'bob', displayName: 'Bob' };
    const fetchAgentProfile = vi.fn(async () => profile as never);
    const { result, rerender } = renderHook(
      ({ username }: { username: string | null }) =>
        useAgentProfile({ username, fetchAgentProfile }),
      { initialProps: { username: 'alice' as string | null } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual(profile);
    rerender({ username: null });
    expect(result.current).toBeNull();

    const owner = { userId: 'u2', username: 'bob' };
    const participants = renderHook(
      ({ sessionOwner }: { sessionOwner: typeof owner | null }) =>
        useSessionParticipants({ sessionOwner, currentUsername: 'alice', fetchAgentProfile }),
      {
        initialProps: { sessionOwner: { userId: 'u1', username: 'alice' } as typeof owner | null },
      },
    );
    expect(participants.result.current[0]).toBeNull();
    participants.rerender({ sessionOwner: owner });
    expect(participants.result.current[0]).toEqual({ owner, agent: null });
    await act(async () => {
      await Promise.resolve();
    });
    expect(participants.result.current[0]).toEqual({ owner, agent: profile });
    participants.rerender({ sessionOwner: null });
    expect(participants.result.current[0]).toBeNull();
  });
});
