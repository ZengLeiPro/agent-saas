import { describe, expect, it, vi } from 'vitest';

import type { MessageItem } from '../types/message';
import { resolveRuntimeStatusPatch } from './runtimeStatusTransition';
import { upsertRuntimeStatusMessage, type MessagesController } from './wsEventProcessor';

const current: Extract<MessageItem, { type: 'runtime_status' }> = {
  id: 'status',
  type: 'runtime_status',
  status: 'running',
  content: '正在思考',
  streamId: 'stream-1',
  runId: 'run-1',
  streaming: true,
  timestamp: 1234,
};

describe('resolveRuntimeStatusPatch', () => {
  it('状态切换保留归属信息，且不会覆盖初始 timestamp', () => {
    const patch = resolveRuntimeStatusPatch(current, 'waiting_hand');

    expect({ ...current, ...patch }).toMatchObject({
      status: 'waiting_hand',
      content: '正在准备工作区',
      streamId: 'stream-1',
      runId: 'run-1',
      timestamp: 1234,
    });
  });

  it('重复的相同思考状态不更新消息', () => {
    const updateMessageAt = vi.fn<MessagesController['updateMessageAt']>();
    const controller: MessagesController = {
      messagesRef: { current: [current] },
      addMessage: vi.fn<MessagesController['addMessage']>(),
      updateMessageAt,
      triggerScroll: vi.fn(),
    };

    upsertRuntimeStatusMessage(controller, 'running', { streamId: 'stream-1', runId: 'run-1' });

    expect(updateMessageAt).not.toHaveBeenCalled();
    expect(controller.messagesRef.current[0]).toBe(current);
  });
});
