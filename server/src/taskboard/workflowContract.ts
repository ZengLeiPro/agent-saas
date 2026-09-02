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
    if (purpose !== 'work' || (!options.activeExecution && expected !== 'work')
      || (options.activeExecution && task.status !== 'in_progress')) {
      invalidPurpose(task, purpose);
    }
    return {
      ...base,
      objective: '自主完成 Integration 代码组合，读取实际 workflow/check/log 完成最终验证，并以标准 GitHub merge、资源清理和任务收口。',
      capabilities: { readContext: true, comment: true, modifyTaskBranch: true, merge: true },
      allowedStatuses: ['done', 'blocked'],
    };
  }
  if (purpose === 'merge') invalidPurpose(task, purpose);
  if (task.kind === 'advisory') {
    if (purpose !== 'work') invalidPurpose(task, purpose);
    return { ...base, taskKind: 'advisory', objective: '完成答复、分析或建议；不得实施外部变更。', capabilities: { readContext: true, comment: true, merge: false }, allowedStatuses: ['todo', 'blocked'] };
  }
  if (purpose === 'review') return {
    ...base, objective: '独立重读当前 PR/head/check/diff，以证据判断批准、退回或等待。', capabilities: { readContext: true, comment: true, inspectPullRequestCi: true, merge: false },
    allowedStatuses: task.kind === 'remediation' ? ['done', 'todo', 'in_review', 'blocked'] : ['ready_to_merge', 'todo', 'in_review', 'blocked'],
  };
  return { ...base, objective: task.kind === 'remediation' ? '完成关联集成问题修复，读取实际检查并交付独立复核。' : '完成任务实施，读取实际检查、分类失败并交付独立复核。', capabilities: { readContext: true, comment: true, modifyTaskBranch: true, createFollowUpTask: true, attachPullRequest: true, inspectPullRequestCi: true, merge: false }, allowedStatuses: ['in_review', 'blocked'] };
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
