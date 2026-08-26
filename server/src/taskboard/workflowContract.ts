import type {
  TaskBoardExecutionPurpose,
  TaskBoardTask,
  TaskBoardWorkflowContract,
} from '../../../shared/src/types/taskboard.js';
import { TaskboardValidationError } from './types.js';
import { assertIntegrationExecutionMigrated, purposeForIntegrationAgentStatus } from './workflow/decider.js';

export function resolveWorkflowContract(
  task: TaskBoardTask,
  requestedPurpose?: TaskBoardExecutionPurpose,
  options: { activeExecution?: boolean } = {},
): TaskBoardWorkflowContract {
  const purpose = requestedPurpose ?? purposeForTask(task);
  const base = { taskKind: task.kind ?? 'delivery', purpose, status: task.status };
  if (task.kind === 'integration') {
    assertIntegrationExecutionMigrated(task);
    const expected = purposeForIntegrationAgentStatus(task.status);
    if (options.activeExecution) {
      const activeStageStatus = purpose === 'review' ? 'in_review' : 'in_progress';
      if (task.status !== activeStageStatus) invalidPurpose(task, purpose);
    } else if (!expected || expected !== purpose) invalidPurpose(task, purpose);
    if (purpose === 'work') return {
      ...base,
      objective: '维护持久 Integration Agent 的单一 branch/PR，并交付独立复核。',
      capabilities: { readContext: true, comment: true, modifyTaskBranch: true, merge: false },
      allowedStatuses: ['in_review', 'blocked'],
    };
    if (purpose === 'review') return {
      ...base,
      objective: '独立复核当前 Integration Agent PR 的精确 head 与 CI。',
      capabilities: { readContext: true, comment: true, approveReviewedSubject: true, inspectPullRequestCi: true, merge: false },
      allowedStatuses: ['ready_to_merge', 'todo', 'in_review', 'blocked'],
    };
    return {
      ...base,
      objective: '通过受控 Merge Gateway 合并当前已批准的 Integration Agent PR。',
      capabilities: { readContext: true, comment: true, mergeIntegrationAgent: true, cleanupIntegrationAgent: true, merge: true },
      allowedStatuses: ['in_progress', 'done', 'blocked'],
    };
  }
  if (purpose === 'merge') invalidPurpose(task, purpose);
  if (task.kind === 'advisory') {
    if (purpose !== 'work') invalidPurpose(task, purpose);
    return { ...base, taskKind: 'advisory', objective: '完成答复、分析或建议；不得实施外部变更。', capabilities: { readContext: true, comment: true, merge: false }, allowedStatuses: ['todo', 'blocked'] };
  }
  if (purpose === 'review') return {
    ...base, objective: '独立复核当前不可变 PR subject。', capabilities: { readContext: true, comment: true, approveReviewedSubject: true, inspectPullRequestCi: true, merge: false },
    allowedStatuses: task.kind === 'remediation' ? ['done', 'todo', 'in_review', 'blocked'] : ['ready_to_merge', 'todo', 'in_review', 'blocked'],
  };
  return { ...base, objective: task.kind === 'remediation' ? '完成关联集成问题修复并交付复核。' : '完成任务实施和自检并交付复核。', capabilities: { readContext: true, comment: true, modifyTaskBranch: true, createFollowUpTask: true, attachPullRequest: true, inspectPullRequestCi: true, merge: false }, allowedStatuses: ['in_review', 'blocked'] };
}

function purposeForTask(task: TaskBoardTask): TaskBoardExecutionPurpose {
  if (task.kind === 'integration') {
    assertIntegrationExecutionMigrated(task);
    const purpose = purposeForIntegrationAgentStatus(task.status);
    if (!purpose) throw new TaskboardValidationError('Integration Agent is not dispatchable', 'TASKBOARD_INTEGRATION_AGENT_EXECUTION_STATE_INVALID');
    return purpose;
  }
  return task.status === 'in_review' ? 'review' : 'work';
}
function invalidPurpose(task: TaskBoardTask, purpose: TaskBoardExecutionPurpose): never {
  throw new TaskboardValidationError(`Purpose ${purpose} is invalid for ${task.kind} task`, 'TASKBOARD_PURPOSE_INVALID');
}
