import { describe, expect, it } from 'vitest';
import type { RenderItem } from './types';
import { groupIntoBubbles } from './groupIntoBubbles';

function activity(id: string): RenderItem {
  return {
    id,
    type: 'activity_group',
    isActive: false,
    items: [{ id: `${id}-thinking`, type: 'thinking', content: '处理中', streaming: false }],
  };
}

describe('groupIntoBubbles', () => {
  it('阶段性正文不切断同一轮活动，直到 finalOutput 才结束气泡', () => {
    const result = groupIntoBubbles([
      activity('activity-1'),
      { id: 'progress', type: 'text', content: '我先核对仓库', runId: 'run-1' },
      activity('activity-2'),
      { id: 'final', type: 'text', content: '核对完成', runId: 'run-1', finalOutput: true },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'ai_bubble',
      items: [{ id: 'activity-1' }, { id: 'progress' }, { id: 'activity-2' }, { id: 'final' }],
    });
  });

  it('用户消息和下一轮最终回答形成新的稳定边界', () => {
    const result = groupIntoBubbles([
      { id: 'final-1', type: 'text', content: '第一轮', finalOutput: true },
      { id: 'user-2', type: 'user', content: '继续' },
      { id: 'progress-2', type: 'text', content: '继续处理' },
      { id: 'final-2', type: 'text', content: '第二轮', finalOutput: true },
    ]);

    expect(result.map((item) => item.type)).toEqual(['ai_bubble', 'user', 'ai_bubble']);
  });
});
