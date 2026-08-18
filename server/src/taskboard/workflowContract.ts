import { createHash } from 'node:crypto';

import type {
  TaskBoardExecutionPurpose,
  TaskBoardTask,
  TaskBoardWorkflowContract,
} from '../../../shared/src/types/taskboard.js';
import { TaskboardValidationError } from './types.js';

export function resolveWorkflowContract(
  task: TaskBoardTask,
  requestedPurpose?: TaskBoardExecutionPurpose,
): TaskBoardWorkflowContract {
  const purpose = requestedPurpose ?? purposeForTask(task);
  const draft = buildContract(task, purpose);
  return {
    ...draft,
    digest: createHash('sha256').update(stableJson(draft)).digest('hex'),
  };
}

export function assertWorkflowOutcome(
  contract: TaskBoardWorkflowContract,
  outcome: string,
): void {
  if (!contract.allowedOutcomes.includes(outcome)) {
    throw new TaskboardValidationError(
      `Outcome ${outcome} is not allowed for ${contract.purpose}`,
      'TASKBOARD_OUTCOME_NOT_ALLOWED',
    );
  }
}

function purposeForTask(task: TaskBoardTask): TaskBoardExecutionPurpose {
  if (task.kind === 'integration') return 'merge';
  return task.status === 'in_review' ? 'review' : 'work';
}

function buildContract(
  task: TaskBoardTask,
  purpose: TaskBoardExecutionPurpose,
): Omit<TaskBoardWorkflowContract, 'digest'> {
  if (task.kind === 'integration') {
    if (purpose !== 'merge') invalidPurpose(task, purpose);
    return {
      taskKind: task.kind ?? 'delivery',
      purpose,
      status: task.status,
      objective: '验证并集成所有冻结来源；自主处理可恢复问题，仅在必须人工介入时停止。',
      capabilities: {
        readContext: true,
        comment: true,
        mergeReviewedSource: true,
        createRemediation: true,
        modifyUnreviewedMain: false,
        deploy: false,
      },
      allowedOutcomes: ['progress', 'completed', 'needs_human'],
      requiredEvidence: ['integration source state', 'provider receipt', 'required checks'],
      blockedReasons: ['business_decision_required', 'authorization_missing', 'automatic_recovery_exhausted'],
    };
  }
  if (purpose === 'merge') invalidPurpose(task, purpose);
  if (task.kind === 'advisory') {
    if (purpose !== 'work') invalidPurpose(task, purpose);
    return {
      taskKind: 'advisory',
      purpose,
      status: task.status,
      objective: '完成答复、分析或建议；不得实施代码、配置或外部系统变更。',
      capabilities: {
        readContext: true,
        comment: true,
        modifyTaskBranch: false,
        attachPullRequest: false,
        createFollowUpTask: false,
        merge: false,
      },
      allowedOutcomes: ['completed', 'blocked'],
      requiredEvidence: ['answer or analysis summary', 'sources or explicit assumptions when needed'],
      blockedReasons: ['business_decision_required', 'external_dependency', 'evidence_missing'],
    };
  }
  if (purpose === 'review') {
    return {
      taskKind: task.kind ?? 'delivery',
      purpose,
      status: task.status,
      objective: '独立复核当前不可变 PR subject，并提交可验证结论。',
      capabilities: {
        readContext: true,
        comment: true,
        modifyTaskBranch: false,
        approveReviewedSubject: true,
        merge: false,
      },
      allowedOutcomes: ['approved', 'changes_requested', 'stale_subject', 'blocked'],
      requiredEvidence: ['reviewed subject digest', 'test or inspection evidence'],
      blockedReasons: ['subject_stale', 'evidence_missing', 'external_dependency'],
    };
  }
  return {
    taskKind: task.kind ?? 'delivery',
    purpose,
    status: task.status,
    objective: task.kind === 'remediation'
      ? '完成关联集成问题的修复，验证结果并交付独立复核。'
      : '完成任务实施和自检，并提交复核所需证据。',
    capabilities: {
      readContext: true,
      comment: true,
      modifyTaskBranch: true,
      createFollowUpTask: true,
      merge: false,
    },
    allowedOutcomes: ['ready_for_review', 'blocked'],
    requiredEvidence: ['implementation summary', 'verification evidence'],
    blockedReasons: ['business_decision_required', 'external_dependency', 'workspace_unavailable'],
  };
}

function invalidPurpose(task: TaskBoardTask, purpose: TaskBoardExecutionPurpose): never {
  throw new TaskboardValidationError(
    `Purpose ${purpose} is invalid for ${task.kind} task`,
    'TASKBOARD_PURPOSE_INVALID',
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
