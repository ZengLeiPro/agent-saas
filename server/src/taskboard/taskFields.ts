import {
  TASKBOARD_PRIORITIES,
  TASKBOARD_STATUSES,
  TASKBOARD_TASK_KINDS,
} from '../../../shared/src/types/taskboard.js';

export function taskTableSql(tasksTable: string, boardsTable: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${tasksTable} (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES ${boardsTable}(id),
      identifier TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'delivery' CHECK (kind IN (${TASKBOARD_TASK_KINDS.map(quoteSqlLiteral).join(', ')})),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL CHECK (status IN (${TASKBOARD_STATUSES.map(quoteSqlLiteral).join(', ')})),
      priority TEXT NOT NULL DEFAULT 'none' CHECK (priority IN (${TASKBOARD_PRIORITIES.map(quoteSqlLiteral).join(', ')})),
      labels TEXT[] NOT NULL DEFAULT '{}',
      sort_order DOUBLE PRECISION NOT NULL,
      due_at TIMESTAMPTZ,
      model TEXT,
      creator_user_id TEXT,
      creator_name TEXT,
      provider_pull_request_id TEXT,
      pull_request_number INTEGER,
      head_oid TEXT,
      base_oid TEXT,
      reviewed_subject_digest TEXT,
      merged_commit_oid TEXT,
      completed_at TIMESTAMPTZ,
      client_request_id TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (board_id, identifier)
    )
  `;
}

export function taskFieldsMigrationSql(tasksTable: string): string {
  return `
    ALTER TABLE ${tasksTable} ADD COLUMN IF NOT EXISTS model TEXT;
    ALTER TABLE ${tasksTable} ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE ${tasksTable} ADD COLUMN IF NOT EXISTS creator_user_id TEXT;
    ALTER TABLE ${tasksTable} ADD COLUMN IF NOT EXISTS creator_name TEXT;
    ALTER TABLE ${tasksTable} ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'delivery';
    ALTER TABLE ${tasksTable} ADD COLUMN IF NOT EXISTS provider_pull_request_id TEXT;
    ALTER TABLE ${tasksTable} ADD COLUMN IF NOT EXISTS pull_request_number INTEGER;
    ALTER TABLE ${tasksTable} ADD COLUMN IF NOT EXISTS head_oid TEXT;
    ALTER TABLE ${tasksTable} ADD COLUMN IF NOT EXISTS base_oid TEXT;
    ALTER TABLE ${tasksTable} ADD COLUMN IF NOT EXISTS reviewed_subject_digest TEXT;
    ALTER TABLE ${tasksTable} ADD COLUMN IF NOT EXISTS merged_commit_oid TEXT;
    ALTER TABLE ${tasksTable} ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
    ALTER TABLE ${tasksTable} ADD COLUMN IF NOT EXISTS client_request_id TEXT;
    ALTER TABLE ${tasksTable} DROP CONSTRAINT IF EXISTS ${tasksTable}_kind_check;
    ALTER TABLE ${tasksTable} ADD CONSTRAINT ${tasksTable}_kind_check
      CHECK (kind IN (${TASKBOARD_TASK_KINDS.map(quoteSqlLiteral).join(', ')}));
    ALTER TABLE ${tasksTable} DROP CONSTRAINT IF EXISTS ${tasksTable}_status_check;
    ALTER TABLE ${tasksTable} ADD CONSTRAINT ${tasksTable}_status_check
      CHECK (status IN (${TASKBOARD_STATUSES.map(quoteSqlLiteral).join(', ')}))
  `;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
