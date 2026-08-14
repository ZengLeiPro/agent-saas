import {
  TASKBOARD_EXECUTION_PURPOSES,
  type TaskBoardExecutionPurpose,
  type TaskBoardStatus,
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
    ALTER TABLE ${executionsTable} DROP CONSTRAINT IF EXISTS ${executionsTable}_purpose_check;
    ALTER TABLE ${executionsTable} ADD CONSTRAINT ${executionsTable}_purpose_check
      CHECK (purpose IN (${purposes}));
    ALTER TABLE ${executionsTable} ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;
    ALTER TABLE ${executionsTable} ADD COLUMN IF NOT EXISTS reconcile_lease_id TEXT;
    ALTER TABLE ${executionsTable} ADD COLUMN IF NOT EXISTS reconcile_lease_expires_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS ${executionsTable}_session_uidx ON ${executionsTable} (session_id)
  `;
}

export function resolveExecutionPurpose(
  status: TaskBoardStatus,
  requested: TaskBoardExecutionPurpose | undefined,
): TaskBoardExecutionPurpose {
  const purpose = requested ?? 'work';
  const requiredStatus = purpose === 'review' ? 'in_review' : 'todo';
  if (status === requiredStatus) return purpose;
  throw new TaskboardValidationError(
    purpose === 'review'
      ? 'Only in-review tasks can be handed to a review Agent'
      : 'Only todo tasks can be handed to Agent',
    purpose === 'review' ? 'TASKBOARD_REVIEW_REQUIRES_IN_REVIEW' : 'TASKBOARD_EXECUTION_REQUIRES_TODO',
  );
}
