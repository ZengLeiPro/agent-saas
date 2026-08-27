import { describe, expect, it, vi } from 'vitest';

import type { MessageItem } from '../types/message';
import { hasTrailingActiveWork, resolveRuntimeStatusPatch } from './runtimeStatusTransition';
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

describe('hasTrailingActiveWork', () => {
  it('仅识别同 run 的流式正文和运行中工具', () => {
    expect(hasTrailingActiveWork([
      { id: 'text', type: 'text', content: '输出中', streaming: true, runId: 'run-1' },
    ], 'run-1')).toBe(true);
    expect(hasTrailingActiveWork([
      { id: 'tool', type: 'tool_use', toolName: 'Shell', toolInput: '{}', toolId: 'tool-1', runId: 'run-1', executionStatus: 'running' },
    ], 'run-1')).toBe(true);
  });

  it.each([
    ['缺少目标 runId', undefined, { id: 'tool', type: 'tool_use', toolName: 'Shell', toolInput: '{}', toolId: 'tool-1', runId: 'run-1', executionStatus: 'running' }],
    ['消息属于其他 run', 'run-2', { id: 'text', type: 'text', content: '旧输出', streaming: true, runId: 'run-1' }],
    ['思考无父 run 归属', 'run-2', { id: 'thinking', type: 'thinking', content: '旧思考', streaming: true }],
    ['子 Agent 无父 run 归属', 'run-2', { id: 'subagent', type: 'subagent', toolId: 'tool-1', agentType: 'coder', status: 'running' }],
  ] as const)('%s 时不抑制', (_label, runId, message) => {
    expect(hasTrailingActiveWork([message as MessageItem], runId)).toBe(false);
  });

  it.each([
    ['completed', { executionStatus: 'completed' as const }],
    ['failed', { executionStatus: 'failed' as const }],
    ['cancelled', { executionStatus: 'cancelled' as const }],
    ['resultReady', { executionStatus: 'running' as const, resultReady: true }],
  ])('streaming=true 不能压过工具终态 %s', (_label, terminal) => {
    expect(hasTrailingActiveWork([{
      id: 'tool',
      type: 'tool_use',
      toolName: 'Shell',
      toolInput: '{}',
      toolId: 'tool-1',
      runId: 'run-1',
      streaming: true,
      ...terminal,
    }], 'run-1')).toBe(false);
  });
});

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
