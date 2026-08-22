import { describe, expect, it } from 'vitest';

import type { TaskboardExecutionContext } from '../taskboard/types.js';
import { executionWritebackInstructions } from '../taskboard/executionService.js';

function context(purpose: 'work' | 'review' | 'merge'): TaskboardExecutionContext {
  return {
    task: { id: 'task-1', boardId: 'board-1' },
    execution: { purpose },
  } as TaskboardExecutionContext;
}

describe('taskboard execution writeback prompt', () => {
  it('所有职责共用稳定总纲，阶段约束由 workflow contract 提供', () => {
    const work = executionWritebackInstructions(context('work')).join('\n');
    const review = executionWritebackInstructions(context('review')).join('\n');
    const merge = executionWritebackInstructions(context('merge')).join('\n');

    expect(work).toBe(review);
    expect(review).toBe(merge);
    expect(work).toContain('读取任务看板返回的最新事实和结构化职责约束');
    expect(work).toContain('提交明确、真实且可验证的阶段结果');
    expect(work).not.toContain('action=');
    expect(work).not.toContain('status=');
    expect(work).not.toContain('target=taskboard');
  });

  it('Workflow v3 Integration Work 明确先受控 push、禁止 git push、后 ready_for_review', () => {
    const integrationWork = context('work');
    integrationWork.task.kind = 'integration';
    integrationWork.task.workflowVersion = 3;
    const prompt = executionWritebackInstructions(integrationWork).join('\n');
    expect(prompt).toContain('integrationCandidate');
    expect(prompt).toContain('sourceSnapshots 中完整冻结来源集');
    expect(prompt).toContain('execution.integration_candidate.push');
    expect(prompt).toContain('只传 commitOid');
    expect(prompt).toContain('基线漂移重建以冻结 base 为父');
    expect(prompt).toContain('不得执行 git push');
    expect(prompt.indexOf('受控 push 成功')).toBeLessThan(prompt.indexOf('ready_for_review') + 1);
    expect(executionWritebackInstructions(context('review')).join('\n')).not.toContain('integration_candidate.push');
  });
});
