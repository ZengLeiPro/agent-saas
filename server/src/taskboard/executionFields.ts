import {
  TASKBOARD_EXECUTION_PURPOSES,
  type TaskBoardExecutionPurpose,
  type TaskBoardIntegrationWorkflowVersion,
  type TaskBoardStageModels,
  type TaskBoardStatus,
  type TaskBoardTaskKind,
} from '../../../shared/src/types/taskboard.js';
import { TaskboardValidationError } from './types.js';
import { assertIntegrationExecutionMigrated, purposeForIntegrationAgentStatus } from './workflow/decider.js';

export function taskFieldMigrationSql(tasksTable: string): string {
  return `
    ALTER TABLE ${tasksTable} ADD COLUMN IF NOT EXISTS model TEXT;
    ALTER TABLE ${tasksTable} ADD COLUMN IF NOT EXISTS branch TEXT;
    ALTER TABLE ${tasksTable} ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb
  `;
}

export function executionFieldMigrationSql(executionsTable: string): string {
  const purposes = TASKBOARD_EXECUTION_PURPOSES.map((value) => `'${value}'`).join(', ');
  return `
    ALTER TABLE ${executionsTable} ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'work';
    ALTER TABLE ${executionsTable} ADD COLUMN IF NOT EXISTS trigger TEXT NOT NULL DEFAULT 'initial';
    ALTER TABLE ${executionsTable} ADD COLUMN IF NOT EXISTS protocol_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE ${executionsTable} ADD COLUMN IF NOT EXISTS attempt_id TEXT;
    ALTER TABLE ${executionsTable} DROP CONSTRAINT IF EXISTS ${executionsTable}_candidate_binding_check;
    ALTER TABLE ${executionsTable} DROP COLUMN IF EXISTS candidate_id;
    ALTER TABLE ${executionsTable} DROP COLUMN IF EXISTS candidate_version;
    ALTER TABLE ${executionsTable} DROP COLUMN IF EXISTS candidate_revision;
    ALTER TABLE ${executionsTable} DROP COLUMN IF EXISTS candidate_work_round;
    ALTER TABLE ${executionsTable} DROP COLUMN IF EXISTS candidate_workflow_epoch;
    ALTER TABLE ${executionsTable} DROP COLUMN IF EXISTS candidate_lane_epoch;
    ALTER TABLE ${executionsTable} DROP COLUMN IF EXISTS candidate_head_oid;
    ALTER TABLE ${executionsTable} DROP CONSTRAINT IF EXISTS ${executionsTable}_trigger_check;
    ALTER TABLE ${executionsTable} ADD CONSTRAINT ${executionsTable}_trigger_check
      CHECK (trigger IN ('initial', 'comment', 'resume', 'retry'));
    ALTER TABLE ${executionsTable} DROP CONSTRAINT IF EXISTS ${executionsTable}_protocol_version_check;
    ALTER TABLE ${executionsTable} ADD CONSTRAINT ${executionsTable}_protocol_version_check
      CHECK (protocol_version IN (1, 2));
    ALTER TABLE ${executionsTable} DROP CONSTRAINT IF EXISTS ${executionsTable}_purpose_check;
    ALTER TABLE ${executionsTable} ADD CONSTRAINT ${executionsTable}_purpose_check
      CHECK (purpose IN (${purposes}));
    ALTER TABLE ${executionsTable} ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;
    ALTER TABLE ${executionsTable} ADD COLUMN IF NOT EXISTS reconcile_lease_id TEXT;
    ALTER TABLE ${executionsTable} ADD COLUMN IF NOT EXISTS reconcile_lease_expires_at TIMESTAMPTZ;
    DROP INDEX IF EXISTS ${executionsTable}_session_uidx;
    CREATE INDEX IF NOT EXISTS ${executionsTable}_session_idx ON ${executionsTable} (session_id, created_at DESC);
  `;
}

export function resolveExecutionModelRef(
  taskModel: string | undefined,
  boardStageModels: TaskBoardStageModels | undefined,
  boardModel: string | undefined,
  purpose: TaskBoardExecutionPurpose,
  taskStageModels?: TaskBoardStageModels,
): string | undefined {
  return taskStageModels?.[purpose] ?? taskModel ?? boardStageModels?.[purpose] ?? boardModel;
}

export function resolveExecutionPurpose(
  status: TaskBoardStatus,
  requested: TaskBoardExecutionPurpose | undefined,
  kind: TaskBoardTaskKind = 'delivery',
  workflowVersion: TaskBoardIntegrationWorkflowVersion = 2,
): TaskBoardExecutionPurpose {
  if (kind === 'integration') {
    assertIntegrationExecutionMigrated({ kind, workflowVersion });
    const expected = purposeForIntegrationAgentStatus(status);
    const purpose = requested ?? expected;
    if (purpose && purpose === expected) return purpose;
    throw new TaskboardValidationError(
      'Integration Agent is not dispatchable for this purpose',
      'TASKBOARD_INTEGRATION_AGENT_EXECUTION_STATE_INVALID',
    );
  }
  const purpose = requested ?? 'work';
  if (purpose === 'merge') {
    throw new TaskboardValidationError(
      'Only integration tasks can use merge execution',
      'TASKBOARD_MERGE_REQUIRES_INTEGRATION',
    );
  }
  const requiredStatus = purpose === 'review' ? 'in_review' : 'todo';
  if (status === requiredStatus) return purpose;
  // 阻塞的交付/修复任务允许人工手动重跑：外部依赖解除后由同一会话补齐证据。
  if (purpose === 'work' && status === 'blocked') return purpose;
  throw new TaskboardValidationError(
    purpose === 'review'
      ? 'Only in-review tasks can be handed to a review Agent'
      : 'Only todo or blocked tasks can be handed to a work Agent',
    purpose === 'review' ? 'TASKBOARD_REVIEW_REQUIRES_IN_REVIEW' : 'TASKBOARD_EXECUTION_REQUIRES_TODO',
  );
}
