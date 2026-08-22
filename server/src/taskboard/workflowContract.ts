import type {
  TaskBoardExecutionPurpose,
  TaskBoardIntegrationCandidateState,
  TaskBoardTask,
  TaskBoardWorkflowContract,
} from '../../../shared/src/types/taskboard.js';
import { TaskboardValidationError } from './types.js';
import { purposeForIntegrationV3Candidate } from './workflow/decider.js';

export interface WorkflowContractOptions { candidateState?: TaskBoardIntegrationCandidateState }

export function resolveWorkflowContract(
  task: TaskBoardTask,
  requestedPurpose?: TaskBoardExecutionPurpose,
  options: WorkflowContractOptions = {},
): TaskBoardWorkflowContract {
  const purpose = requestedPurpose ?? purposeForTask(task, options);
  const base = { taskKind: task.kind ?? 'delivery', purpose, status: task.status };
  if (task.kind === 'integration') {
    if (task.workflowVersion === 3) {
      const expected = options.candidateState && purposeForIntegrationV3Candidate(options.candidateState);
      if (!expected || expected !== purpose) invalidPurpose(task, purpose);
      return purpose === 'work'
        ? { ...base, objective: '修复当前 candidate revision，受控 push 后请求系统复核。', capabilities: { readContext: true, comment: true, modifyTaskBranch: true, merge: false }, allowedStatuses: ['in_review', 'blocked'] }
        : { ...base, objective: '独立复核绑定的 candidate revision。', capabilities: { readContext: true, comment: true, approveReviewedSubject: true, merge: false }, allowedStatuses: ['ready_to_merge', 'todo', 'in_review', 'blocked'] };
    }
    if (purpose !== 'merge') invalidPurpose(task, purpose);
    return { ...base, objective: '验证并集成所有冻结来源。', capabilities: { readContext: true, comment: true, mergeReviewedSource: true, createRemediation: true }, allowedStatuses: ['in_progress', 'done', 'blocked'] };
  }
  if (purpose === 'merge') invalidPurpose(task, purpose);
  if (task.kind === 'advisory') {
    if (purpose !== 'work') invalidPurpose(task, purpose);
    return { ...base, taskKind: 'advisory', objective: '完成答复、分析或建议；不得实施外部变更。', capabilities: { readContext: true, comment: true, merge: false }, allowedStatuses: ['todo', 'blocked'] };
  }
  if (purpose === 'review') return {
    ...base, objective: '独立复核当前不可变 PR subject。', capabilities: { readContext: true, comment: true, approveReviewedSubject: true, merge: false },
    allowedStatuses: task.kind === 'remediation' ? ['done', 'todo', 'in_review', 'blocked'] : ['ready_to_merge', 'todo', 'in_review', 'blocked'],
  };
  return { ...base, objective: task.kind === 'remediation' ? '完成关联集成问题修复并交付复核。' : '完成任务实施和自检并交付复核。', capabilities: { readContext: true, comment: true, modifyTaskBranch: true, createFollowUpTask: true, merge: false }, allowedStatuses: ['in_review', 'blocked'] };
}

function purposeForTask(task: TaskBoardTask, options: WorkflowContractOptions): TaskBoardExecutionPurpose {
  if (task.kind === 'integration') {
    if (task.workflowVersion === 3) {
      const purpose = options.candidateState && purposeForIntegrationV3Candidate(options.candidateState);
      if (!purpose) throw new TaskboardValidationError('Workflow v3 contract requires a dispatchable candidate', 'TASKBOARD_CANDIDATE_EXECUTION_STATE_INVALID');
      return purpose;
    }
    return 'merge';
  }
  return task.status === 'in_review' ? 'review' : 'work';
}
function invalidPurpose(task: TaskBoardTask, purpose: TaskBoardExecutionPurpose): never {
  throw new TaskboardValidationError(`Purpose ${purpose} is invalid for ${task.kind} task`, 'TASKBOARD_PURPOSE_INVALID');
}
