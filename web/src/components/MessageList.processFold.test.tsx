import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  content: 'WorkBuddy 现在公开的用户数等指标，是什么情况',
  timestamp: 100,
  clientMsgId: 'client-message-id',
};

function completedTool(id: string): MessageItem {
  return {
    id,
    type: 'tool_use',
    toolName: 'WebSearch',
    toolId: id,
    toolInput: '{}',
    executionStatus: 'completed',
    resultReady: true,
    result: 'ok',
    durationMs: 1200,
    runId: 'run-fold',
  };
}

function completedTurn(): MessageItem[] {
  return [
    userMessage,
    completedTool('tool-1'),
    {
      id: 'commentary-1',
      type: 'text',
      content: '先核对记忆里有没有 WorkBuddy 的既有口径',
      runId: 'run-fold',
    },
    completedTool('tool-2'),
    {
      id: 'commentary-2',
      type: 'text',
      content: '记忆里只有 7 月口径',
      runId: 'run-fold',
    },
    {
      id: 'final-answer',
      type: 'text',
      content: '结论先说：腾讯到现在也没公开绝对 MAU',
      finalOutput: true,
      runId: 'run-fold',
    },
  ];
}

describe('MessageList 过程记录折叠', () => {
  it('完成后主区看不到 commentary，看得到过程记录；展开后 commentary 可见', async () => {
    render(<MessageList messages={completedTurn()} loading={false} />);

    await waitFor(() => expect(screen.getByTestId('turn-process-fold')).toBeTruthy());
    expect(screen.getByText('过程记录')).toBeTruthy();
    expect(screen.queryByText('先核对记忆里有没有 WorkBuddy 的既有口径')).toBeNull();
    expect(screen.queryByText('记忆里只有 7 月口径')).toBeNull();
    expect(screen.getByText('结论先说：腾讯到现在也没公开绝对 MAU')).toBeTruthy();
    expect(screen.getByTestId('final-output-divider')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /过程记录/ }));
    expect(screen.getByText('先核对记忆里有没有 WorkBuddy 的既有口径')).toBeTruthy();
    expect(screen.getByText('记忆里只有 7 月口径')).toBeTruthy();
  });

  it('AskUser 在折叠态仍可见可点', async () => {
    const onAskUserResponse = vi.fn();
    render(
      <MessageList
        messages={[
          userMessage,
          completedTool('tool-1'),
          {
            id: 'ask',
            type: 'ask_user',
            interactionId: 'ask-1',
            questions: [{
              question: '选一个方向',
              header: '方向',
              options: [{ label: '公开口径', description: '只用公开数字' }],
              multiSelect: false,
            }],
            status: 'pending',
          },
          {
            id: 'final-answer',
            type: 'text',
            content: '等你选完再继续',
            finalOutput: true,
            runId: 'run-fold',
          },
        ]}
        loading={false}
        onAskUserResponse={onAskUserResponse}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('turn-process-fold')).toBeTruthy());
    expect(screen.getByText('选一个方向')).toBeTruthy();
    expect(screen.getByRole('button', { name: /公开口径/ })).toBeTruthy();
  });

  it('排队、运行中和首段输出不出现过程记录折行', async () => {
    const view = render(
      <MessageList
        messages={[
          userMessage,
          { id: 'runtime-queued', type: 'runtime_status', status: 'queued', runId: 'run-fold', timestamp: 101 },
        ]}
        loading
      />,
    );
    await waitFor(() => expect(document.querySelector('[data-message-virtual-key="assistant-turn:client-message-id:100"]')).toBeTruthy());
    expect(screen.queryByTestId('turn-process-fold')).toBeNull();

    view.rerender(
      <MessageList
        messages={[
          userMessage,
          { id: 'runtime-running', type: 'runtime_status', status: 'running', runId: 'run-fold', timestamp: 101 },
        ]}
        loading
      />,
    );
    expect(screen.queryByTestId('turn-process-fold')).toBeNull();

    view.rerender(
      <MessageList
        messages={[
          userMessage,
          {
            id: 'commentary-1',
            type: 'text',
            content: '先核对记忆里有没有 WorkBuddy 的既有口径',
            streaming: true,
            runId: 'run-fold',
          },
        ]}
        loading
      />,
    );
    expect(screen.queryByTestId('turn-process-fold')).toBeNull();
    expect(screen.getByText('先核对记忆里有没有 WorkBuddy 的既有口径')).toBeTruthy();
  });

  it('失败轮没有 finalOutput 时不折', async () => {
    render(
      <MessageList
        messages={[
          userMessage,
          completedTool('tool-1'),
          {
            id: 'failed-text',
            type: 'text',
            content: '这一轮执行失败了',
            runId: 'run-fold',
          },
        ]}
        loading={false}
      />,
    );
    await waitFor(() => expect(screen.getByText('这一轮执行失败了')).toBeTruthy());
    expect(screen.queryByTestId('turn-process-fold')).toBeNull();
    expect(screen.queryByTestId('final-output-divider')).toBeNull();
  });
});
