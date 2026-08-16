import {
  TASKBOARD_EXECUTION_PURPOSES,
  type TaskBoardExecutionPurpose,
  type TaskBoardStatus,
  type TaskBoardTaskKind,
} from '../../../shared/src/types/taskboard.js';
import { TaskboardValidationError } from './types.js';

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
    CREATE INDEX IF NOT EXISTS ${executionsTable}_session_idx ON ${executionsTable} (session_id, created_at DESC)
  `;
}

export function resolveExecutionPurpose(
  status: TaskBoardStatus,
  requested: TaskBoardExecutionPurpose | undefined,
  kind: TaskBoardTaskKind = 'delivery',
): TaskBoardExecutionPurpose {
  const purpose = requested ?? (kind === 'integration' ? 'merge' : 'work');
  if (purpose === 'merge') {
    if (kind === 'integration' && (status === 'todo' || status === 'in_progress' || status === 'blocked')) {
      return purpose;
    }
    throw new TaskboardValidationError(
      'Only active integration tasks can be handed to a merge Agent',
      'TASKBOARD_MERGE_REQUIRES_INTEGRATION',
    );
  }
  if (kind === 'integration') {
    throw new TaskboardValidationError(
      'Integration tasks only accept merge execution',
      'TASKBOARD_INTEGRATION_PURPOSE_INVALID',
    );
  }
  const requiredStatus = purpose === 'review' ? 'in_review' : 'todo';
  if (status === requiredStatus) return purpose;
  throw new TaskboardValidationError(
    purpose === 'review'
      ? 'Only in-review tasks can be handed to a review Agent'
      : 'Only todo tasks can be handed to Agent',
    purpose === 'review' ? 'TASKBOARD_REVIEW_REQUIRES_IN_REVIEW' : 'TASKBOARD_EXECUTION_REQUIRES_TODO',
  );
}
