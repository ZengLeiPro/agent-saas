import {
  TASKBOARD_DEFAULT_PROMPT,
  TASKBOARD_EXECUTION_PURPOSES,
  TASKBOARD_STAGE_DEFAULT_PROMPTS,
  TASKBOARD_EXECUTION_STATUSES,
} from '../../../shared/src/types/taskboard.js';
import {
  boardIntegrationMigrationSql,
  boardModelMigrationSql,
  boardPromptMigrationSql,
  boardStageModelsMigrationSql,
  boardStagePromptsMigrationSql,
  boardVisibilityMigrationSql,
} from './boardFields.js';
import {
  continuationOutboxIndexSql,
  continuationOutboxTableSql,
  runContinuationOutboxMigrations,
} from './continuationOutbox.js';
import { executionFieldMigrationSql, taskFieldMigrationSql } from './executionFields.js';
import { runExecutionOutboxMigrations } from './executionOutboxStore.js';
import { retireIntegrationCandidateSchema } from './retiredIntegrationCandidateSchema.js';
import { quoteSqlLiteral } from './storeHelpers.js';
import { taskFieldsMigrationSql, taskTableSql } from './taskFields.js';
import { retireTaskboardResolutionSchema, runTaskboardV2Schema } from './v2Schema.js';
import type { PgTaskboardStore } from './store.js';

export async function initializeTaskboardStore(store: PgTaskboardStore): Promise<void> {
  const lockKey = `${store.boardsTable}:init`;
  const client = await store.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${store.boardsTable} (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        visibility TEXT NOT NULL DEFAULT 'personal'
          CHECK (visibility IN ('personal', 'organization')),
        prompt TEXT NOT NULL DEFAULT ${quoteSqlLiteral(TASKBOARD_DEFAULT_PROMPT)},
        stage_models JSONB NOT NULL DEFAULT '{}'::jsonb,
        stage_prompts JSONB NOT NULL DEFAULT ${quoteSqlLiteral(JSON.stringify(TASKBOARD_STAGE_DEFAULT_PROMPTS))}::jsonb,
        model TEXT,
        repository JSONB,
        integration_policy JSONB,
        integration_next_run_at TIMESTAMPTZ,
        next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number >= 1),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        archived_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(boardPromptMigrationSql(store.boardsTable));
    await client.query(boardStageModelsMigrationSql(store.boardsTable));
    await client.query(boardStagePromptsMigrationSql(store.boardsTable));
    await client.query(boardModelMigrationSql(store.boardsTable));
    await client.query(boardVisibilityMigrationSql(store.boardsTable));
    await client.query(boardIntegrationMigrationSql(store.boardsTable));
    await client.query(taskTableSql(store.tasksTable, store.boardsTable));
    await client.query(taskFieldsMigrationSql(store.tasksTable));
    await client.query(taskFieldMigrationSql(store.tasksTable));
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${store.commentsTable} (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES ${store.tasksTable}(id),
        body TEXT NOT NULL,
        attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
        author_type TEXT NOT NULL DEFAULT 'user'
          CHECK (author_type IN ('user', 'agent', 'system')),
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        continuation_eligible BOOLEAN NOT NULL DEFAULT true,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      ALTER TABLE ${store.commentsTable} ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE ${store.commentsTable} ADD COLUMN IF NOT EXISTS continuation_eligible BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE ${store.commentsTable} ALTER COLUMN continuation_eligible SET DEFAULT true;
      ALTER TABLE ${store.commentsTable} ADD COLUMN IF NOT EXISTS continuation_run_id TEXT;
      ALTER TABLE ${store.commentsTable}
        DROP CONSTRAINT IF EXISTS ${store.commentsTable}_author_type_check;
      ALTER TABLE ${store.commentsTable}
        ADD CONSTRAINT ${store.commentsTable}_author_type_check
        CHECK (author_type IN ('user', 'agent', 'system'))
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${store.executionsTable} (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES ${store.tasksTable}(id),
        run_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN (${TASKBOARD_EXECUTION_STATUSES.map(quoteSqlLiteral).join(', ')})),
        purpose TEXT NOT NULL DEFAULT 'work'
          CHECK (purpose IN (${TASKBOARD_EXECUTION_PURPOSES.map(quoteSqlLiteral).join(', ')})),
        trigger TEXT NOT NULL DEFAULT 'initial'
          CHECK (trigger IN ('initial', 'comment', 'resume', 'retry')),
        protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version IN (1, 2)),
        attempt_id TEXT,
        requested_by TEXT NOT NULL,
        error TEXT,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        last_reconciled_at TIMESTAMPTZ,
        reconcile_lease_id TEXT,
        reconcile_lease_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await retireIntegrationCandidateSchema(store.integrationSourcesTable, client);
    await client.query(executionFieldMigrationSql(store.executionsTable));
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${store.executionOutboxTable} (
        run_id TEXT PRIMARY KEY REFERENCES ${store.executionsTable}(run_id),
        execution_id TEXT NOT NULL REFERENCES ${store.executionsTable}(id),
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'dispatching', 'dispatched')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        lease_id TEXT,
        lease_expires_at TIMESTAMPTZ,
        last_error TEXT,
        dispatched_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(continuationOutboxTableSql(
      store.continuationOutboxTable,
      store.tasksTable,
      store.commentsTable,
    ));
    await runExecutionOutboxMigrations(store, client);
    await runContinuationOutboxMigrations(store, client, store.executionsTable);
    await runTaskboardV2Schema(store, client);
    await client.query(`DROP INDEX IF EXISTS ${store.boardsTable}_active_name_uidx`);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${store.boardsTable}_personal_name_uidx `
      + `ON ${store.boardsTable} (tenant_id, owner_user_id, lower(name)) `
      + `WHERE archived_at IS NULL AND visibility='personal'`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${store.boardsTable}_org_name_uidx `
      + `ON ${store.boardsTable} (tenant_id, lower(name)) `
      + `WHERE archived_at IS NULL AND visibility='organization'`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${store.boardsTable}_access_idx `
      + `ON ${store.boardsTable} (tenant_id, visibility, owner_user_id, updated_at DESC)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${store.tasksTable}_board_column_idx `
      + `ON ${store.tasksTable} (board_id, status, sort_order)`,
    );
    await client.query(`DROP INDEX IF EXISTS ${store.tasksTable}_client_request_uidx`);
    await client.query(`CREATE UNIQUE INDEX ${store.tasksTable}_client_request_uidx ON ${store.tasksTable} (board_id, client_request_id) WHERE client_request_id IS NOT NULL AND deleted_at IS NULL`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${store.tasksTable}_board_archived_idx `
      + `ON ${store.tasksTable} (board_id, archived_at, updated_at DESC)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${store.commentsTable}_task_idx `
      + `ON ${store.commentsTable} (task_id, created_at ASC)`,
    );
    await client.query(`DROP INDEX IF EXISTS ${store.commentsTable}_continuation_run_uidx`);
    await client.query(`CREATE INDEX IF NOT EXISTS ${store.commentsTable}_continuation_run_idx ON ${store.commentsTable} (continuation_run_id) WHERE continuation_run_id IS NOT NULL`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${store.executionsTable}_task_idx `
      + `ON ${store.executionsTable} (task_id, created_at DESC)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${store.executionsTable}_reconcile_v2_idx `
      + `ON ${store.executionsTable} (COALESCE(last_reconciled_at, '-infinity'::timestamptz), updated_at, run_id) `
      + `WHERE status IN ('queued', 'running', 'waiting_user', 'waiting_approval')`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS ${store.executionOutboxTable}_due_idx `
      + `ON ${store.executionOutboxTable} (next_attempt_at, created_at) `
      + `WHERE status IN ('pending', 'dispatching')`,
    );
    for (const indexSql of continuationOutboxIndexSql(store.continuationOutboxTable)) {
      await client.query(indexSql);
    }
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${store.executionsTable}_active_uidx `
      + `ON ${store.executionsTable} (task_id) `
      + `WHERE status IN ('queued', 'running', 'waiting_user', 'waiting_approval')`,
    );
    await retireTaskboardResolutionSchema(store, client);
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
    client.release();
  }
}
