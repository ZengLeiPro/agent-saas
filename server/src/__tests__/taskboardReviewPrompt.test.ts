import { describe, expect, it } from 'vitest';

import type { TaskboardExecutionContext } from '../taskboard/types.js';
import { executionWritebackInstructions } from '../taskboard/executionService.js';

function context(purpose: 'work' | 'review'): TaskboardExecutionContext {
  return {
    task: { id: 'task-1', boardId: 'board-1' },
    execution: { purpose },
  } as TaskboardExecutionContext;
}

describe('taskboard execution writeback prompt', () => {
  it('实施 Agent 只回写分支，并把验收留给独立复核', () => {
    const instructions = executionWritebackInstructions(context('work')).join('\n');

    expect(instructions).toContain('action=update, id=task-1, branch=<分支名>');
    expect(instructions).toContain('action=create, boardId=board-1, status=todo, dispatch=true');
    expect(instructions).toContain('不要标记待合并或已完成');
    expect(instructions).toContain('自动派发复核');
    expect(instructions).not.toContain('status=done');
  });

  it('复核 Agent 可以进入待合并、退回返工或标记阻塞，但不能确认完成', () => {
    const instructions = executionWritebackInstructions(context('review')).join('\n');

    expect(instructions).toContain('本次只做独立复核，不顺手修改交付');
    expect(instructions).toContain('target=taskboard, action=move, id=task-1, status=ready_to_merge');
    expect(instructions).toContain('target=taskboard, action=move, id=task-1, status=todo');
    expect(instructions).toContain('target=taskboard, action=move, id=task-1, status=blocked');
    expect(instructions).not.toContain('status=done');
    expect(instructions).toContain('无法明确判定时不要移动状态');
  });
});
