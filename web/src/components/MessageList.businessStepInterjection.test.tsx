import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { MessageItem } from '@agent/shared';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', username: 'tester', tenantId: 'tenant-a', debugMode: false, preferences: {} },
  }),
}));
vi.mock('@/hooks/useVoicePlayer', () => ({
  useVoicePlayer: () => ({
    activeId: null, getState: () => 'idle', play: vi.fn(), togglePause: vi.fn(), stop: vi.fn(),
  }),
}));

import { MessageList } from './MessageList';

beforeAll(() => {
  Range.prototype.getClientRects = () => ({
    length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList;
});

function snapshot(id: string, stage: 1 | 2 | 3): MessageItem {
  return {
    id, type: 'tool_use', toolId: id, toolName: 'TodoWrite', runId: 'run-1',
    resultReady: true, executionStatus: 'completed', result: 'ok',
    toolInput: JSON.stringify({ todos: [
      { id: 'verify', kind: 'business', content: '核验 PR', status: stage === 1 ? 'in_progress' : 'completed' },
      { id: 'archive', kind: 'business', content: '归档结果', status: stage === 3 ? 'completed' : stage === 2 ? 'in_progress' : 'pending' },
    ] }),
  };
}

function Harness({ messages, loading }: { messages: MessageItem[]; loading: boolean }) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <MessageList
        messages={messages}
        loading={loading}
        sessionId="interjection-session"
        businessStepDetailMode="desktop"
        businessStepDetailHost={host}
        businessStepPanelOpen={open}
        onBusinessStepPanelOpenChange={setOpen}
      />
      <div ref={setHost} data-testid="detail-host" />
    </>
  );
}

async function expectPlanAfter(text: string): Promise<Element> {
  let card: Element | null = null;
  await waitFor(() => {
    expect(document.querySelectorAll('[data-business-step-plan]')).toHaveLength(1);
    card = document.querySelector('[data-business-step-plan]');
    expect(screen.getByText(text).compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING)
      .not.toBe(0);
  });
  return card!;
}

describe('MessageList 插话后的业务步骤卡位置', () => {
  it('立即跟随连续插话、保留详情选择，完成与重新加载后仍只有同一张卡', async () => {
    const initial: MessageItem[] = [
      { id: 'request', type: 'user', content: '请检查并归档' },
      { id: 'intro', type: 'text', content: '开始检查。', runId: 'run-1' },
      snapshot('start', 1),
    ];
    const { rerender } = render(<Harness messages={initial} loading />);
    await waitFor(() => expect(document.querySelector('[data-business-step-plan]')).toBeTruthy());
    const planId = document.querySelector('[data-business-step-plan]')?.getAttribute('data-business-step-plan');
    fireEvent.click(screen.getByRole('button', { name: /核验 PR/ }));
    await waitFor(() => expect(screen.getByLabelText('步骤详情：核验 PR')).toBeTruthy());

    const first: MessageItem = { id: 'aside-1', type: 'user', content: '先忽略额度问题', status: 'pending' };
    rerender(<Harness messages={[...initial, first]} loading />);
    await expectPlanAfter(first.content);
    expect(screen.getByLabelText('步骤详情：核验 PR')).toBeTruthy();

    const second: MessageItem = { id: 'aside-2', type: 'user', content: '还有，保留测试记录', status: 'sent' };
    const interjected: MessageItem[] = [...initial, { ...first, status: 'sent' }, second];
    rerender(<Harness messages={interjected} loading />);
    await expectPlanAfter(second.content);
    expect(screen.getByText('开始检查。').compareDocumentPosition(screen.getByText(first.content))
      & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    const progressed: MessageItem[] = [
      ...interjected,
      { id: 'process', type: 'text', content: '正在继续核验并记录测试', runId: 'run-1' },
      snapshot('progress', 2),
    ];
    rerender(<Harness messages={progressed} loading />);
    const moved = await expectPlanAfter(second.content);
    expect(moved.getAttribute('data-business-step-plan')).toBe(planId);
    await waitFor(() => expect(screen.getByLabelText('步骤详情：归档结果')).toBeTruthy());
    const main = document.querySelector<HTMLElement>('[data-message-scroll-container]')!;
    expect(within(main).queryByText('正在继续核验并记录测试')).toBeNull();

    const complete: MessageItem[] = [
      ...progressed, snapshot('complete', 3),
      { id: 'final', type: 'text', content: '检查与归档已完成', runId: 'run-1', finalOutput: true },
    ];
    rerender(<Harness messages={complete} loading={false} />);
    const finished = await expectPlanAfter(second.content);
    expect(finished.compareDocumentPosition(screen.getByText('检查与归档已完成'))
      & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    // A remount has no client-side relocation state to rely on (refresh / history replay).
    rerender(<Harness key="reloaded" messages={complete} loading={false} />);
    const reloaded = await expectPlanAfter(second.content);
    expect(reloaded.getAttribute('data-business-step-plan')).toBe(planId);
  });
});
