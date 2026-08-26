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
      expect(prompt).toContain('execution.finish');
      expect(prompt).toContain('明确、真实且可验证的交接评论');
      expect(prompt).toContain('工作过程中不要写 Agent 进度评论');
      expect(prompt).not.toContain('status=');
      expect(prompt).not.toContain('target=taskboard');
    }
    expect(work).toContain('execution.pull_request.inspect');
    expect(work).toContain('pending、failure、unknown 均不得提交复核');
    expect(review).toContain('不得复用 Work 阶段旧结果');
    expect(review).toContain('inspection receipt');
    expect(merge).not.toContain('integration.source.');
  });

  it('Integration 只提示一个持久 Agent 自主完成合并与安全清理', () => {
    const integrationWork = context('work');
    integrationWork.task.kind = 'integration';
    integrationWork.task.workflowVersion = 3;

    const prompt = executionWritebackInstructions(integrationWork).join('\n');

    expect(prompt).toContain('唯一的持久 Agent');
    expect(prompt).toContain('标准 Git 与 GitHub 能力');
    expect(prompt).toContain('重新读取 GitHub 与本地 Git 的实际状态');
    expect(prompt).toContain('本批次拥有的本地 worktree、本地分支、远程分支和临时目录');
    expect(prompt).toContain('execution.finish({targetStatus: "done", body})');
    expect(prompt).not.toContain('integration.agent.merge');
    expect(prompt).not.toContain('integration.agent.cleanup');
    expect(prompt).not.toContain('Merge Gateway');
    expect(prompt).not.toMatch(/candidate/i);
  });
});
