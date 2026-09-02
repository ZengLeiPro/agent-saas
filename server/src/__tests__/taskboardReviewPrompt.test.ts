import { describe, expect, it } from 'vitest';

import type { TaskboardExecutionContext } from '../taskboard/types.js';
import { executionWritebackInstructions } from '../taskboard/executionService.js';

function context(purpose: 'work' | 'review' | 'merge'): TaskboardExecutionContext {
  return {
    task: { id: 'task-1', boardId: 'board-1', kind: 'delivery' },
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
    expect(work).toContain('pending 是正常等待状态');
    expect(work).toContain('主线公共故障或无关/无适用 job');
    expect(review).toContain('不得复用 Work 的结论');
    expect(review).toContain('红 CI 只有在有直接证据');
    expect(review).toContain('服务端不会要求 inspection receipt');
    expect(merge).not.toContain('integration.source.');
  });

  it('按 Advisory 与 Remediation 的真实合同生成动态职责', () => {
    const advisory = context('work');
    advisory.task.kind = 'advisory';
    const advisoryPrompt = executionWritebackInstructions(advisory).join('\n');
    expect(advisoryPrompt).toContain('Advisory 只完成答复、分析或建议');
    expect(advisoryPrompt).not.toContain('execution.pull_request.inspect');
    expect(advisoryPrompt).not.toContain('in_review');

    const remediationWork = context('work');
    remediationWork.task.kind = 'remediation';
    expect(executionWritebackInstructions(remediationWork).join('\n'))
      .toContain('必须复用关联 Delivery 的原分支、worktree 和 PR');

    const remediationReview = context('review');
    remediationReview.task.kind = 'remediation';
    const reviewPrompt = executionWritebackInstructions(remediationReview).join('\n');
    expect(reviewPrompt).toContain('Remediation 批准时提交 done');
    expect(reviewPrompt).not.toContain('Delivery 批准时提交 ready_to_merge');
  });

  it('Integration 只提示一个持久 Agent 自主完成合并与安全清理', () => {
    const integrationWork = context('work');
    integrationWork.task.kind = 'integration';
    integrationWork.task.workflowVersion = 3;

    const prompt = executionWritebackInstructions(integrationWork).join('\n');

    expect(prompt).toContain('唯一的持久 Agent');
    expect(prompt).toContain('标准 Git 与 GitHub merge 能力');
    expect(prompt).toContain('重读 GitHub 与本地 Git 实际状态');
    expect(prompt).toContain('integrationPolicy 允许删除的资源');
    expect(prompt).toContain('deleteRemoteBranch=false 时保留远程分支');
    expect(prompt).toContain('以 done 收口');
    expect(prompt).not.toContain('integration.agent.merge');
    expect(prompt).not.toContain('integration.agent.cleanup');
    expect(prompt).not.toContain('Merge Gateway');
    expect(prompt).not.toMatch(/candidate/i);
  });
});
