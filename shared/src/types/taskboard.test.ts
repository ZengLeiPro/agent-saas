import { describe, expect, it } from 'vitest';

import {
  TASKBOARD_DEFAULT_MERGE_PROMPT,
  TASKBOARD_DEFAULT_PROMPT,
  TASKBOARD_DEFAULT_REVIEW_PROMPT,
  TASKBOARD_DEFAULT_WORK_PROMPT,
  TASKBOARD_STAGE_DEFAULT_PROMPTS,
  type TaskBoardIntegrationPolicy,
} from './taskboard.js';

const policy: TaskBoardIntegrationPolicy = {
  schemaVersion: 1,
  enabled: true,
  revision: 'test',
  workflowVersion: 3,
  trigger: { mode: 'manual', allowedRoles: ['owner'] },
  batch: { maxTasks: 10, selection: 'priority_then_ready_at' },
  execution: {
    mergeMethod: 'squash',
    continueIndependentSources: true,
    autoResolveConflicts: true,
    maxAutomaticRemediationRounds: 2,
    maxTransientRetries: 3,
    deleteRemoteBranch: false,
    deploy: false,
  },
};

// @ts-expect-error v2 is historical task data, not a writable integration policy version.
const legacyPolicy: TaskBoardIntegrationPolicy = { ...policy, workflowVersion: 2 };

const flaggedPolicy: TaskBoardIntegrationPolicy = {
  ...policy,
  // @ts-expect-error featureFlags is no longer part of the shared writable contract.
  featureFlags: { engineV3: true },
};

void legacyPolicy;
void flaggedPolicy;

describe('taskboard default prompts', () => {
  it('uses distinct, repository-agnostic prompts with a publishable Integration gate', () => {
    expect(new Set(Object.values(TASKBOARD_STAGE_DEFAULT_PROMPTS))).toHaveProperty('size', 3);
    expect(TASKBOARD_STAGE_DEFAULT_PROMPTS).toEqual({
      work: TASKBOARD_DEFAULT_WORK_PROMPT,
      review: TASKBOARD_DEFAULT_REVIEW_PROMPT,
      merge: TASKBOARD_DEFAULT_MERGE_PROMPT,
    });
    for (const prompt of [TASKBOARD_DEFAULT_PROMPT, ...Object.values(TASKBOARD_STAGE_DEFAULT_PROMPTS)]) {
      expect(prompt).not.toContain('code/agent-saas');
      expect(prompt).not.toContain('目标分支为 main');
      expect(prompt).not.toContain('status=');
      expect(prompt).not.toContain('target=taskboard');
      expect(prompt).not.toContain('execution.integration_candidate.push');
      expect(prompt).not.toContain('execution.review_subject.record');
    }
    expect(TASKBOARD_DEFAULT_PROMPT).toContain('工作过程中不得写 Agent 进度评论');
    expect(TASKBOARD_DEFAULT_PROMPT).toContain('普通文本回复不构成阶段完成');
    expect(TASKBOARD_DEFAULT_PROMPT).toContain('不得仅因 CI、后台任务或工具结果暂时 pending 而结束 Run');
    expect(TASKBOARD_DEFAULT_WORK_PROMPT).toContain('### Advisory Work');
    expect(TASKBOARD_DEFAULT_WORK_PROMPT).toContain('### Remediation Work');
    expect(TASKBOARD_DEFAULT_WORK_PROMPT).toContain('execution.pull_request.inspect');
    expect(TASKBOARD_DEFAULT_WORK_PROMPT).toContain('只调用一次 execution.finish');
    expect(TASKBOARD_DEFAULT_WORK_PROMPT).toContain('服务端只维护事实一致性，不替 Agent 判断');
    expect(TASKBOARD_DEFAULT_REVIEW_PROMPT).toContain('不得直接采信 Work 交接');
    expect(TASKBOARD_DEFAULT_REVIEW_PROMPT).toContain('PR、head 或 base 变化后必须重新复核');
    expect(TASKBOARD_DEFAULT_REVIEW_PROMPT).toContain('红 CI 仅在有直接证据');
    expect(TASKBOARD_DEFAULT_REVIEW_PROMPT).toContain('Remediation 通过时 finish(done)');
    expect(TASKBOARD_DEFAULT_REVIEW_PROMPT).toContain('Delivery 通过时 finish(ready_to_merge)');
    expect(TASKBOARD_DEFAULT_MERGE_PROMPT).toContain('deleteRemoteBranch=false');
    expect(TASKBOARD_DEFAULT_MERGE_PROMPT).toContain('不得加入未冻结来源、来源后续新增 commit、其他仓库或无关资源');
    expect(TASKBOARD_DEFAULT_MERGE_PROMPT).toContain('清理只处理本批次拥有且无未合并提交的资源');
    expect(TASKBOARD_DEFAULT_MERGE_PROMPT).toContain('结果不确定时，先重读事实');
    expect(TASKBOARD_DEFAULT_MERGE_PROMPT).toContain('上游失败造成的 skipped/canceled 不算成功');
    expect(TASKBOARD_DEFAULT_MERGE_PROMPT).toContain('合并后适用 CI/CD 均成功');
  });
});

describe('TaskBoardIntegrationPolicy writable contract', () => {
  it('contains only the Agent-first workflow version and no feature flags', () => {
    expect(policy.workflowVersion).toBe(3);
    expect(policy).not.toHaveProperty('featureFlags');
  });
});
