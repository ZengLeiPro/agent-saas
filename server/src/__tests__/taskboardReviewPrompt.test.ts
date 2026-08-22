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
  it('各阶段共用稳定总纲并明确独立的 Provider CI 检查职责', () => {
    const work = executionWritebackInstructions(context('work')).join('\n');
    const review = executionWritebackInstructions(context('review')).join('\n');
    const merge = executionWritebackInstructions(context('merge')).join('\n');

    for (const prompt of [work, review, merge]) {
      expect(prompt).toContain('读取任务看板返回的最新事实和结构化职责约束');
      expect(prompt).toContain('提交明确、真实且可验证的阶段结果');
      expect(prompt).not.toContain('status=');
      expect(prompt).not.toContain('target=taskboard');
    }
    expect(work).toContain('execution.pull_request.inspect');
    expect(work).toContain('pending、failure、unknown 均不得提交复核');
    expect(review).toContain('不得复用 Work 阶段旧结果');
    expect(review).toContain('inspection receipt');
    expect(merge).toContain('integration.source.inspect');
    expect(merge).toContain('Provider 不可用时失败关闭');
  });

  it('Workflow v3 Integration Review 明确检查并绑定当前 candidate revision', () => {
    const integrationReview = context('review');
    integrationReview.task.kind = 'integration';
    integrationReview.task.workflowVersion = 3;

    const prompt = executionWritebackInstructions(integrationReview).join('\n');

    expect(prompt).toContain('execution.pull_request.inspect');
    expect(prompt).toContain('当前 candidate revision');
    expect(prompt).toContain('candidate/revision/subject');
    expect(prompt).toContain('服务端硬门禁');
  });

  it('Workflow v3 Integration Work 明确先受控 push、禁止 git push、后 ready_for_review', () => {
    const integrationWork = context('work');
    integrationWork.task.kind = 'integration';
    integrationWork.task.workflowVersion = 3;
    const prompt = executionWritebackInstructions(integrationWork).join('\n');
    expect(prompt).toContain('execution.integration_candidate.push');
    expect(prompt).toContain('只传 commitOid');
    expect(prompt).toContain('基线漂移重建以冻结 base 为父');
    expect(prompt).toContain('不得执行 git push');
    expect(prompt.indexOf('受控 push 成功')).toBeLessThan(prompt.indexOf('ready_for_review') + 1);
    expect(executionWritebackInstructions(context('review')).join('\n')).not.toContain('integration_candidate.push');
  });
});
