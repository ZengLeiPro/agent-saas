import { render, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { MessageItem } from '@agent/shared';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', username: 'tester', tenantId: 'tenant-a', debugMode: false },
  }),
}));

vi.mock('@/hooks/useVoicePlayer', () => ({
  useVoicePlayer: () => ({
    activeId: null,
    getState: () => 'idle',
    play: vi.fn(),
    togglePause: vi.fn(),
    stop: vi.fn(),
  }),
}));

import { MessageList } from './MessageList';

beforeAll(() => {
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: [][Symbol.iterator],
    }) as unknown as DOMRectList;
});

const userMessage: MessageItem = {
  id: 'user-message',
  type: 'user',
  content: '开始执行',
  timestamp: 100,
  clientMsgId: 'client-message-id',
};

function runtimeStatus(status: 'queued' | 'running'): MessageItem {
  return {
    id: `runtime-${status}`,
    type: 'runtime_status',
    status,
    runId: 'run-stable',
    timestamp: 101,
  };
}

function assistantRow(): HTMLElement {
  return document.querySelector(
    '[data-message-virtual-key="assistant-turn:client-message-id:100"]',
  ) as HTMLElement;
}

describe('MessageList 流式消息布局稳定性', () => {
  it('排队、运行中和首段输出复用同一虚拟行与 AI 气泡 DOM', async () => {
    const view = render(
      <MessageList
        messages={[
          userMessage,
          { id: 'runtime-sending', type: 'runtime_status', status: 'sending' },
        ]}
        loading
      />,
    );
    await waitFor(() => expect(assistantRow()).toBeTruthy());
    const queuedRow = assistantRow();
    const queuedBubble = queuedRow.firstElementChild;

    view.rerender(<MessageList messages={[userMessage, runtimeStatus('queued')]} loading />);
    await waitFor(() => expect(assistantRow()).toBe(queuedRow));
    expect(assistantRow().firstElementChild).toBe(queuedBubble);

    view.rerender(<MessageList messages={[userMessage, runtimeStatus('running')]} loading />);
    await waitFor(() => expect(assistantRow()).toBe(queuedRow));
    expect(assistantRow().firstElementChild).toBe(queuedBubble);

    const firstOutput: MessageItem = {
      id: 'first-thinking',
      type: 'thinking',
      content: '正在分析',
      streaming: true,
      runId: 'run-stable',
    };
    view.rerender(<MessageList messages={[userMessage, firstOutput]} loading />);
    await waitFor(() => expect(assistantRow()).toBe(queuedRow));
    expect(assistantRow().firstElementChild).toBe(queuedBubble);
  });
});
