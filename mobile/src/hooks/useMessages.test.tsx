// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessages } from './useMessages';
import type { MessageItem } from '@agent/shared';

const contentOf = (m: MessageItem) => (m as { content?: string }).content;

describe('mobile useMessages（shared 消息缓冲内核）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('同一批次内多次修改只提交一次 state，且 messagesRef 立即可读', async () => {
    const { result } = renderHook(() => useMessages());
    const renders: unknown[] = [];
    act(() => {
      const first = result.current.addMessage({ type: 'user', content: 'a' });
      renders.push(result.current.messages);
      result.current.addMessage({ type: 'text', content: 'b' });
      result.current.updateMessageAt(first, (m) => ({ ...m, content: 'a!' }) as MessageItem);
    });
    expect(result.current.messagesRef.current.map(contentOf)).toEqual(['a!', 'b']);
    expect(result.current.messages).toHaveLength(0);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.messages.map(contentOf)).toEqual(['a!', 'b']);
    expect(result.current.messages.every((m) => typeof m.id === 'string' && m.id.length > 0)).toBe(
      true,
    );
  });

  it('setMessages 立即提交、补齐缺失 id、取消未执行的 flush，且不强制滚动', async () => {
    const { result } = renderHook(() => useMessages());
    act(() => {
      result.current.addMessage({ type: 'user', content: '未 flush' });
    });
    act(() => {
      result.current.setMessages([
        { id: 'keep', type: 'user', content: 'x' },
        { type: 'text', content: 'y' },
      ]);
    });
    expect(result.current.messages.map(contentOf)).toEqual(['x', 'y']);
    expect(result.current.messages[0]?.id).toBe('keep');
    expect(result.current.messages[1]?.id).toMatch(/^msg-/);
    expect(result.current.shouldScrollRef.current).toBe(false);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.messages.map(contentOf)).toEqual(['x', 'y']);

    act(() => {
      result.current.triggerScroll();
    });
    expect(result.current.shouldScrollRef.current).toBe(true);
  });

  it('resetMessages 清空并丢弃在途 flush', async () => {
    const { result } = renderHook(() => useMessages());
    act(() => {
      result.current.addMessage({ type: 'user', content: 'a' });
    });
    act(() => {
      result.current.resetMessages();
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.messagesRef.current).toEqual([]);
  });

  it('updateMessageAt 越界时忽略', async () => {
    const { result } = renderHook(() => useMessages());
    act(() => {
      result.current.updateMessageAt(3, (m) => m);
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current.messages).toEqual([]);
  });
});
