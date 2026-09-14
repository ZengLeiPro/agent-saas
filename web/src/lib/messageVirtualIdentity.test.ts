import { describe, expect, it } from 'vitest';
import type { BubbleRenderItem } from '@/components/groupIntoBubbles';
import { getBubbleVirtualKey, getBubbleVirtualKeys } from './messageVirtualIdentity';

function statusBubble(status: 'queued' | 'running'): BubbleRenderItem {
  return {
    type: 'ai_bubble',
    id: 'bubble-ag-runtime-status',
    items: [
      {
        type: 'activity_group',
        id: 'ag-runtime-status',
        isActive: true,
        items: [
          {
            id: 'runtime-status',
            type: 'runtime_status',
            status,
            runId: 'run-stable',
            timestamp: 100,
          },
        ],
      },
    ],
  };
}

const userBubble: BubbleRenderItem = {
  id: 'local-user-id',
  type: 'user',
  content: '开始',
  clientMsgId: 'client-message-id',
  timestamp: 99,
};

describe('getBubbleVirtualKey', () => {
  it('排队切换到运行中时保留同一虚拟行身份', () => {
    expect(getBubbleVirtualKey(statusBubble('queued'))).toBe(
      getBubbleVirtualKey(statusBubble('running')),
    );
  });

  it('临时状态行被首个真实输出替换后仍绑定同一 run', () => {
    const firstOutput: BubbleRenderItem = {
      type: 'ai_bubble',
      id: 'bubble-first-thinking',
      items: [
        {
          type: 'activity_group',
          id: 'ag-first-thinking',
          isActive: true,
          items: [
            {
              id: 'first-thinking',
              type: 'thinking',
              content: '开始处理',
              streaming: true,
              runId: 'run-stable',
            },
          ],
        },
      ],
    };

    expect(getBubbleVirtualKey(statusBubble('running'))).toBe('assistant-run:run-stable');
    expect(getBubbleVirtualKey(firstOutput)).toBe('assistant-run:run-stable');
  });

  it('发送阶段没有 runId，服务端补 runId 后仍绑定同一用户轮次', () => {
    const sending: BubbleRenderItem = {
      type: 'ai_bubble',
      id: 'bubble-sending',
      items: [
        {
          type: 'activity_group',
          id: 'ag-sending',
          isActive: true,
          items: [{ id: 'runtime-sending', type: 'runtime_status', status: 'sending' }],
        },
      ],
    };

    expect(getBubbleVirtualKeys([userBubble, sending])).toEqual([
      'local-user-id:99',
      'assistant-turn:client-message-id:99',
    ]);
    expect(getBubbleVirtualKeys([userBubble, statusBubble('running')])).toEqual([
      'local-user-id:99',
      'assistant-turn:client-message-id:99',
    ]);
  });

  it('没有 runId 的历史消息继续用原始 id 和时间戳隔离', () => {
    const legacy: BubbleRenderItem = {
      type: 'ai_bubble',
      id: 'bubble-line-1',
      items: [{ id: 'line-1', type: 'text', content: '历史消息', timestamp: 123 }],
    };

    expect(getBubbleVirtualKey(legacy)).toBe('bubble-line-1:123');
  });

  it('同一 run 的多段气泡不会产生重复 React key', () => {
    const first = statusBubble('running');
    const second = { ...first, id: 'bubble-late-output' };

    expect(getBubbleVirtualKeys([first, second])).toEqual([
      'assistant-run:run-stable',
      'assistant-run:run-stable:segment-2',
    ]);
  });
});
