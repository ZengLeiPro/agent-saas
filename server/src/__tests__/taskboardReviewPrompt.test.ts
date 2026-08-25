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

  it('Workflow v3 Integration Review 明确检查并绑定当前 Integration Agent PR', () => {
    const integrationReview = context('review');
    integrationReview.task.kind = 'integration';
    integrationReview.task.workflowVersion = 3;

    const prompt = executionWritebackInstructions(integrationReview).join('\n');

    expect(prompt).toContain('execution.pull_request.inspect');
    expect(prompt).toContain('当前 Integration Agent 的精确 PR/head/base');
    expect(prompt).toContain('Integration Agent 当前 PR/head/subject');
    expect(prompt).not.toMatch(/candidate/i);
    expect(prompt).toContain('服务端硬门禁');
  });

  it('Workflow v3 Integration Work 按持久 Integration Agent 对账和受控合并', () => {
    const integrationWork = context('work');
    integrationWork.task.kind = 'integration';
    integrationWork.task.workflowVersion = 3;
    const prompt = executionWritebackInstructions(integrationWork).join('\n');
    expect(prompt).toContain('持久的 Integration Agent');
    expect(prompt).toContain('GitHub PR、head 与 CI 为唯一代码事实');
    expect(prompt).toContain('同一 integration branch/PR');
    expect(prompt).toContain('受控 Merge Gateway');
    expect(prompt).not.toContain('execution.integration_candidate.push');
    expect(prompt).not.toMatch(/candidate/i);
  });
});
