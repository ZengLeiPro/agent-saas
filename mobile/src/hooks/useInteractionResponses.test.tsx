// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageItem, WsEvent } from '@agent/shared';

const h = vi.hoisted(() => ({
  ensureConnectedSend: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true),
  alert: vi.fn(),
}));

vi.mock('@agent/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/shared')>();
  return { ...actual, wsClient: { ensureConnectedSend: h.ensureConnectedSend } };
});
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, Alert: { alert: h.alert } };
});

import { useInteractionResponses } from './useInteractionResponses';

function setup() {
  const messages: MessageItem[] = [
    {
      id: 'p1',
      type: 'permission_request',
      interactionId: 'i1',
      interactionVersion: 3,
      status: 'pending',
      toolName: 'Shell',
      toolInput: 'ls',
    } as unknown as MessageItem,
  ];
  const msg = {
    messagesRef: { current: messages },
    addMessage: vi.fn((m: MessageItem) => {
      messages.push(m);
      return messages.length - 1;
    }),
    updateMessageAt: vi.fn((i: number, u: (m: MessageItem) => MessageItem) => {
      messages[i] = u(messages[i]);
    }),
    setMessages: vi.fn((next: MessageItem[]) => {
      messages.splice(0, messages.length, ...next);
    }),
  };
  const session = { applySessionInteractionEvent: vi.fn() };
  const resolved = new Set<string>();
  const deps = {
    msgRef: { current: msg as never },
    sessionIdRef: { current: 's1' as string | null },
    sessionRef: { current: session as never },
    resolvedInteractionIdsRef: { current: resolved },
  };
  return { messages, msg, session, resolved, deps };
}

describe('mobile useInteractionResponses', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.ensureConnectedSend.mockReset();
    h.ensureConnectedSend.mockResolvedValue(true);
    h.alert.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('提交带 interactionVersion 的 respond；ACK 前重复提交被忽略；respond_error 保持 pending 并提示', async () => {
    const { messages, msg, deps } = setup();
    const { result } = renderHook(() => useInteractionResponses(deps));
    await act(async () => {
      await result.current.handlePermissionResponse('i1', false);
    });
    expect(h.ensureConnectedSend).toHaveBeenCalledTimes(1);
    expect(h.ensureConnectedSend.mock.calls[0]?.[0]).toMatchObject({
      action: 'respond',
      interactionId: 'i1',
      sessionId: 's1',
      version: 3,
      allow: false,
      message: 'User denied',
    });
    await act(async () => {
      await result.current.handlePermissionResponse('i1', true);
    });
    expect(h.ensureConnectedSend).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.resolveInteractionResponse({
        type: 'respond_error',
        interactionId: 'i1',
        sessionId: 's1',
        error: '版本过期',
      } as WsEvent as never);
    });
    expect(messages[0]).toMatchObject({ status: 'pending' });
    expect(msg.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'system-error', content: '回复未提交：版本过期。请重试。' }),
    );
    expect(h.alert).toHaveBeenCalledWith('回复未提交', '版本过期。请重试。');

    // 提交锁已释放，可再次提交
    await act(async () => {
      await result.current.handlePermissionResponse('i1', true);
    });
    expect(h.ensureConnectedSend).toHaveBeenCalledTimes(2);
  });

  it('respond_ok 记住已终态、通知列表并投影消息；accepted 只续等待，超时后释放并提示', async () => {
    const { msg, session, resolved, deps } = setup();
    const { result } = renderHook(() => useInteractionResponses(deps));
    await act(async () => {
      await result.current.handleAskUserResponse('i1', { q: 'a' } as never);
    });
    act(() => {
      result.current.resolveInteractionResponse({
        type: 'respond_ok',
        interactionId: 'i1',
        sessionId: 's1',
        status: 'accepted',
      } as WsEvent as never);
    });
    expect(session.applySessionInteractionEvent).not.toHaveBeenCalled();
    act(() => {
      result.current.resolveInteractionResponse({
        type: 'respond_ok',
        interactionId: 'i1',
        sessionId: 's1',
        status: 'resolved',
        response: { answers: { q: 'a' } },
      } as WsEvent as never);
    });
    expect(session.applySessionInteractionEvent).toHaveBeenCalledWith({
      type: 'resolved',
      sessionId: 's1',
      interactionId: 'i1',
    });
    expect(resolved.size).toBe(1);
    expect(msg.setMessages).toHaveBeenCalledTimes(1);

    // 无 ACK：15s 后释放提交锁并给出可见提示
    const fresh = setup();
    const second = renderHook(() => useInteractionResponses(fresh.deps));
    await act(async () => {
      await second.result.current.handlePermissionResponse('i1', true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fresh.msg.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system-error',
        content: '回复未确认：等待服务端确认超时。请重试。',
      }),
    );
    await act(async () => {
      await second.result.current.handlePermissionResponse('i1', true);
    });
    expect(h.ensureConnectedSend).toHaveBeenCalledTimes(3);
  });

  it('传输失败立即释放；连接断开时 releaseAll 提示且仅对当前会话写消息', async () => {
    const { msg, deps } = setup();
    h.ensureConnectedSend.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useInteractionResponses(deps));
    await act(async () => {
      await result.current.handlePermissionResponse('i1', true);
    });
    expect(msg.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '回复未确认：网络连接失败。请重试。' }),
    );

    await act(async () => {
      await result.current.handlePermissionResponse('i1', true);
    });
    deps.sessionIdRef.current = 's2';
    act(() => {
      result.current.releaseAllInteractionResponses('连接已断开');
    });
    expect(msg.addMessage).toHaveBeenCalledTimes(1);
    deps.sessionIdRef.current = 's1';
    await act(async () => {
      await result.current.handlePermissionResponse('i1', true);
    });
    expect(h.ensureConnectedSend).toHaveBeenCalledTimes(3);
  });
});
