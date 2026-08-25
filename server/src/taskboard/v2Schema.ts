import type { PoolClient } from 'pg';

import { integrationAgentTableNames, runIntegrationAgentSchema } from './integrationAgentSchema.js';

interface TaskboardV2SchemaOptions {
  boardsTable: string;
  tasksTable: string;
  commentsTable: string;
  executionsTable: string;
  membersTable: string;
  changesTable: string;
  attemptsTable: string;
  integrationLanesTable: string;
  integrationSourcesTable: string;
  mergeAuthorizationsTable: string;
  mergeOperationsTable: string;
  blockEpisodesTable: string;
  integrationTriggerOutboxTable: string;
  remediationAttemptsTable: string;
  cancellationOutboxTable: string;
  watchersTable: string;
  statusNotificationOutboxTable: string;
}

export async function runTaskboardV2Schema(
  options: TaskboardV2SchemaOptions,
  client: PoolClient,
): Promise<void> {
  await client.query(`
    ALTER TABLE ${options.tasksTable}
      ADD COLUMN IF NOT EXISTS resume_context JSONB
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${options.membersTable} (
      board_id TEXT NOT NULL REFERENCES ${options.boardsTable}(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'maintainer')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (board_id, user_id)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${options.watchersTable} (
      task_id TEXT NOT NULL REFERENCES ${options.tasksTable}(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (task_id, user_id)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${options.statusNotificationOutboxTable} (
      id BIGSERIAL PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES ${options.tasksTable}(id) ON DELETE CASCADE,
      board_id TEXT NOT NULL REFERENCES ${options.boardsTable}(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL,
      task_identifier TEXT NOT NULL,
      task_title TEXT NOT NULL,
      task_version INTEGER NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL CHECK (to_status IN ('blocked','done','canceled')),
      recipient_user_ids TEXT[] NOT NULL,
      event_summary TEXT,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','delivered','failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      lease_id TEXT,
      lease_expires_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      delivered_at TIMESTAMPTZ,
      UNIQUE (task_id, task_version, to_status)
    )
  `);
  await client.query(`
    ALTER TABLE ${options.statusNotificationOutboxTable}
      ADD COLUMN IF NOT EXISTS board_id TEXT REFERENCES ${options.boardsTable}(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS tenant_id TEXT,
      ADD COLUMN IF NOT EXISTS task_identifier TEXT,
      ADD COLUMN IF NOT EXISTS task_title TEXT,
      ADD COLUMN IF NOT EXISTS recipient_user_ids TEXT[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS event_summary TEXT
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${options.statusNotificationOutboxTable}_claim_idx
      ON ${options.statusNotificationOutboxTable} (state, available_at, id)
      WHERE state IN ('pending','processing')
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION ${options.statusNotificationOutboxTable}_enqueue()
    RETURNS trigger AS $$
    BEGIN
      IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('blocked','done','canceled') THEN
        INSERT INTO ${options.statusNotificationOutboxTable}
          (task_id, board_id, tenant_id, task_identifier, task_title, task_version, from_status, to_status,
           recipient_user_ids, event_summary)
        SELECT NEW.id, NEW.board_id, b.tenant_id, NEW.identifier, NEW.title, NEW.version, OLD.status, NEW.status,
          ARRAY(
            SELECT DISTINCT recipient.user_id
            FROM (
              SELECT NEW.creator_user_id AS user_id
              UNION ALL
              SELECT (SELECT e.requested_by FROM ${options.executionsTable} e WHERE e.task_id=NEW.id ORDER BY e.created_at DESC,e.id DESC LIMIT 1)
              UNION ALL
              SELECT w.user_id FROM ${options.watchersTable} w WHERE w.task_id=NEW.id
            ) recipient
            WHERE recipient.user_id IS NOT NULL AND btrim(recipient.user_id)<>''
          ),
          (SELECT c.body FROM ${options.commentsTable} c
            WHERE c.task_id=NEW.id AND c.author_type='agent'
              AND c.author_id=(SELECT e.run_id FROM ${options.executionsTable} e WHERE e.task_id=NEW.id ORDER BY e.created_at DESC,e.id DESC LIMIT 1)
            ORDER BY c.created_at DESC,c.id DESC LIMIT 1)
        FROM ${options.boardsTable} b WHERE b.id=NEW.board_id
        ON CONFLICT (task_id, task_version, to_status) DO NOTHING;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS ${options.statusNotificationOutboxTable}_trigger ON ${options.tasksTable};
    CREATE CONSTRAINT TRIGGER ${options.statusNotificationOutboxTable}_trigger
      AFTER UPDATE ON ${options.tasksTable}
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ${options.statusNotificationOutboxTable}_enqueue()
  `);
  await client.query(`
    DELETE FROM ${options.statusNotificationOutboxTable}
    WHERE board_id IS NULL
  `);
  await client.query(`
    ALTER TABLE ${options.statusNotificationOutboxTable}
      ALTER COLUMN board_id SET NOT NULL,
      ALTER COLUMN tenant_id SET NOT NULL,
      ALTER COLUMN task_identifier SET NOT NULL,
      ALTER COLUMN task_title SET NOT NULL,
      ALTER COLUMN recipient_user_ids DROP DEFAULT
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${options.changesTable} (
      seq BIGSERIAL PRIMARY KEY,
      task_id TEXT REFERENCES ${options.tasksTable}(id) ON DELETE CASCADE,
      board_id TEXT REFERENCES ${options.boardsTable}(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL DEFAULT 'task',
      resource_id TEXT GENERATED ALWAYS AS (COALESCE(task_id, board_id)) STORED,
      change_type TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
      actor_id TEXT NOT NULL,
      execution_id TEXT REFERENCES ${options.executionsTable}(id),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      tombstone BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    ALTER TABLE ${options.changesTable} ALTER COLUMN task_id DROP NOT NULL;
    ALTER TABLE ${options.changesTable} ADD COLUMN IF NOT EXISTS board_id TEXT REFERENCES ${options.boardsTable}(id) ON DELETE CASCADE;
    ALTER TABLE ${options.changesTable} ADD COLUMN IF NOT EXISTS resource_type TEXT NOT NULL DEFAULT 'task';
    ALTER TABLE ${options.changesTable} ADD COLUMN IF NOT EXISTS resource_id TEXT GENERATED ALWAYS AS (COALESCE(task_id, board_id)) STORED;
    ALTER TABLE ${options.changesTable} ADD COLUMN IF NOT EXISTS execution_id TEXT REFERENCES ${options.executionsTable}(id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${options.changesTable}_task_seq_idx
      ON ${options.changesTable} (task_id, seq)
  `);
  await client.query(`
    CREATE OR REPLACE RULE ${options.changesTable}_no_update AS
      ON UPDATE TO ${options.changesTable} DO INSTEAD NOTHING;
    CREATE OR REPLACE RULE ${options.changesTable}_no_delete AS
      ON DELETE TO ${options.changesTable} DO INSTEAD NOTHING
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${options.attemptsTable} (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL REFERENCES ${options.executionsTable}(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK (trigger IN ('initial', 'comment', 'resume', 'retry')),
      dispatch_source TEXT NOT NULL,
      actor_user_id TEXT,
      policy_revision TEXT,
      context_start_seq BIGINT NOT NULL DEFAULT 0,
      subject_digest TEXT,
      lane_epoch BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${options.attemptsTable}_execution_idx
      ON ${options.attemptsTable} (execution_id, created_at DESC)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${options.integrationLanesTable} (
      repository_id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL UNIQUE REFERENCES ${options.boardsTable}(id) ON DELETE CASCADE,
      active_integration_task_id TEXT REFERENCES ${options.tasksTable}(id),
      epoch BIGINT NOT NULL DEFAULT 0,
      lease_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${options.integrationSourcesTable} (
      id TEXT PRIMARY KEY,
      integration_task_id TEXT NOT NULL REFERENCES ${options.tasksTable}(id) ON DELETE CASCADE,
      delivery_task_id TEXT NOT NULL REFERENCES ${options.tasksTable}(id),
      repository_id TEXT NOT NULL,
      provider_pull_request_id TEXT NOT NULL,
      reviewed_subject_digest TEXT NOT NULL,
      frozen_head_oid TEXT,
      source_order INTEGER NOT NULL CHECK (source_order >= 0),
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','validating','ready','merging','merged','waiting_retry','re_reviewing','resolving_conflict','waiting_remediation','needs_human','canceled')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      remediation_count INTEGER NOT NULL DEFAULT 0 CHECK (remediation_count >= 0),
      provider_receipt_id TEXT,
      merged_commit_oid TEXT,
      remediation_task_id TEXT REFERENCES ${options.tasksTable}(id),
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (integration_task_id, delivery_task_id)
    )
  `);
  await client.query(`
    ALTER TABLE ${options.integrationSourcesTable}
      ADD COLUMN IF NOT EXISTS frozen_head_oid TEXT;
    ALTER TABLE ${options.integrationSourcesTable}
      ADD COLUMN IF NOT EXISTS remediation_task_id TEXT REFERENCES ${options.tasksTable}(id);
    ALTER TABLE ${options.integrationSourcesTable}
      ADD COLUMN IF NOT EXISTS remediation_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE ${options.integrationSourcesTable}
      DROP CONSTRAINT IF EXISTS ${options.integrationSourcesTable}_state_check;
    ALTER TABLE ${options.integrationSourcesTable}
      ADD CONSTRAINT ${options.integrationSourcesTable}_state_check
      CHECK (state IN ('pending','validating','ready','merging','merged','waiting_retry','re_reviewing','resolving_conflict','waiting_remediation','needs_human','canceled'))
  `);
  await client.query(`
    DROP INDEX IF EXISTS ${options.integrationSourcesTable}_active_delivery_uidx;
    CREATE UNIQUE INDEX ${options.integrationSourcesTable}_active_delivery_uidx
      ON ${options.integrationSourcesTable} (delivery_task_id)
      WHERE state NOT IN ('merged','canceled')
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${options.integrationSourcesTable}_task_order_idx
      ON ${options.integrationSourcesTable} (integration_task_id, source_order)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${options.mergeAuthorizationsTable} (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('scheduled_policy','on_ready_policy','manual_batch')),
      actor_user_id TEXT,
      repository_id TEXT NOT NULL,
      integration_task_id TEXT NOT NULL REFERENCES ${options.tasksTable}(id) ON DELETE CASCADE,
      policy_revision TEXT NOT NULL,
      expires_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${options.mergeOperationsTable} (
      id TEXT PRIMARY KEY,
      integration_source_id TEXT NOT NULL UNIQUE REFERENCES ${options.integrationSourcesTable}(id) ON DELETE CASCADE,
      authorization_id TEXT NOT NULL REFERENCES ${options.mergeAuthorizationsTable}(id),
      repository_id TEXT NOT NULL,
      provider_pull_request_id TEXT NOT NULL,
      expected_head_oid TEXT NOT NULL,
      expected_base_oid TEXT NOT NULL,
      reviewed_subject_digest TEXT NOT NULL,
      method TEXT NOT NULL CHECK (method IN ('merge','squash','rebase')),
      state TEXT NOT NULL CHECK (state IN ('prepared','executing','succeeded','failed','unknown','reconciled')),
      provider_request_id TEXT,
      provider_receipt JSONB,
      merged_commit_oid TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${options.mergeOperationsTable}_reconcile_idx
      ON ${options.mergeOperationsTable} (state, updated_at)
      WHERE state IN ('executing','unknown')
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${options.blockEpisodesTable} (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES ${options.tasksTable}(id) ON DELETE CASCADE,
      purpose TEXT,
      execution_id TEXT REFERENCES ${options.executionsTable}(id),
      reason_code TEXT NOT NULL,
      reason TEXT NOT NULL,
      related_source_ids TEXT[] NOT NULL DEFAULT '{}',
      opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      closed_at TIMESTAMPTZ
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${options.blockEpisodesTable}_task_open_idx
      ON ${options.blockEpisodesTable} (task_id, opened_at DESC)
      WHERE closed_at IS NULL
  `);
  await client.query(`
    ALTER TABLE ${options.tasksTable} ADD COLUMN IF NOT EXISTS workflow_epoch BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE ${options.tasksTable} ADD COLUMN IF NOT EXISTS next_action TEXT;
    ALTER TABLE ${options.tasksTable} ADD COLUMN IF NOT EXISTS next_action_revision BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE ${options.executionsTable} ADD COLUMN IF NOT EXISTS transitioned_at TIMESTAMPTZ;
    ALTER TABLE ${options.executionsTable} ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
    ALTER TABLE ${options.executionsTable} ADD COLUMN IF NOT EXISTS fence_epoch BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE ${options.executionsTable} ADD COLUMN IF NOT EXISTS terminal_reason_code TEXT;
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${options.remediationAttemptsTable} (
      id TEXT PRIMARY KEY,
      integration_source_id TEXT NOT NULL REFERENCES ${options.integrationSourcesTable}(id) ON DELETE CASCADE,
      round INTEGER NOT NULL CHECK (round > 0),
      remediation_task_id TEXT NOT NULL UNIQUE REFERENCES ${options.tasksTable}(id),
      state TEXT NOT NULL CHECK (state IN ('active','resolved','superseded','canceled')),
      base_head_oid TEXT,
      completed_head_oid TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      superseded_at TIMESTAMPTZ,
      UNIQUE (integration_source_id, round)
    )
  `);
  await client.query(`
    ALTER TABLE ${options.remediationAttemptsTable}
      ADD COLUMN IF NOT EXISTS base_head_oid TEXT;
    ALTER TABLE ${options.remediationAttemptsTable}
      ADD COLUMN IF NOT EXISTS completed_head_oid TEXT
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${options.cancellationOutboxTable} (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL UNIQUE REFERENCES ${options.executionsTable}(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES ${options.tasksTable}(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      fence_epoch BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${options.cancellationOutboxTable}_pending_idx
      ON ${options.cancellationOutboxTable}(created_at) WHERE status IN ('pending','failed')
  `);
  await client.query(`
    DO $migration$
    DECLARE duplicate_summary TEXT;
    BEGIN
      SELECT string_agg(repository_id || ':' || provider_pull_request_id || '=' || duplicate_count, ', ')
        INTO duplicate_summary
        FROM (
          SELECT repository_id,provider_pull_request_id,count(*)::text AS duplicate_count
            FROM ${options.integrationSourcesTable}
           WHERE state NOT IN ('merged','canceled')
           GROUP BY repository_id,provider_pull_request_id HAVING count(*) > 1
           ORDER BY repository_id,provider_pull_request_id
           LIMIT 20
        ) duplicates;
      IF duplicate_summary IS NOT NULL THEN
        RAISE EXCEPTION 'TASKBOARD_ACTIVE_PR_DUPLICATES: %. Run repair:taskboard-workflow --apply, then retry schema initialization.', duplicate_summary;
      END IF;
      EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS ${options.integrationSourcesTable}_apr_uq'
        || ' ON ${options.integrationSourcesTable}(repository_id,provider_pull_request_id)'
        || ' WHERE state NOT IN (''merged'',''canceled'')';
      IF to_regclass('${options.integrationSourcesTable}_apr_uq') IS NULL THEN
        RAISE EXCEPTION 'TASKBOARD_ACTIVE_PR_INDEX_MISSING';
      END IF;
    END $migration$
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${options.integrationTriggerOutboxTable} (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES ${options.boardsTable}(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES ${options.tasksTable}(id) ON DELETE CASCADE,
      trigger_mode TEXT NOT NULL CHECK (trigger_mode IN ('scheduled','on_ready','manual')),
      policy_revision TEXT NOT NULL,
      available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
      lease_id TEXT,
      lease_expires_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${options.integrationTriggerOutboxTable}_pending_board_uidx
      ON ${options.integrationTriggerOutboxTable} (board_id)
      WHERE status IN ('pending','processing')
  `);
  // Agent-first integrations still use workflow_version, but Candidate tables
  // are historical-only and must never be installed by a new runtime.
  await client.query(`
    ALTER TABLE ${options.tasksTable}
      ADD COLUMN IF NOT EXISTS workflow_version SMALLINT NOT NULL DEFAULT 2
      CHECK (workflow_version IN (2, 3))
  `);
  await runIntegrationAgentSchema(options, client);
  const { agentsTable } = integrationAgentTableNames(options.integrationSourcesTable);
  await client.query(`
    CREATE OR REPLACE FUNCTION ${options.tasksTable}_workflow_version_immutable_fn()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.workflow_version IS DISTINCT FROM OLD.workflow_version THEN
        IF OLD.workflow_version=2 AND NEW.workflow_version=3
           AND OLD.kind='integration' AND NEW.kind='integration'
           AND EXISTS (
             SELECT 1
               FROM ${agentsTable} agent
               JOIN ${options.integrationLanesTable} lane
                 ON lane.active_integration_task_id=NEW.id
                AND lane.repository_id=agent.repository_id
                AND lane.board_id=NEW.board_id
              WHERE agent.integration_task_id=NEW.id
                AND agent.integration_branch='integration/' || NEW.id
                AND agent.delivery_source_ids=(
                  SELECT jsonb_agg(source.id ORDER BY source.source_order)
                    FROM ${options.integrationSourcesTable} source
                   WHERE source.integration_task_id=NEW.id
                )
                AND agent.repository_id=(
                  SELECT min(source.repository_id)
                    FROM ${options.integrationSourcesTable} source
                   WHERE source.integration_task_id=NEW.id
                  HAVING count(*)>0 AND count(DISTINCT source.repository_id)=1
                )
           ) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'TASKBOARD_WORKFLOW_VERSION_IMMUTABLE';
      END IF;
      RETURN NEW;
    END
    $function$;
    DO $trigger$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid='${options.tasksTable}'::regclass
           AND tgname=left('${options.tasksTable}_workflow_version_immutable',
                           current_setting('max_identifier_length')::int)
           AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER ${options.tasksTable}_workflow_version_immutable
          BEFORE UPDATE OF workflow_version ON ${options.tasksTable}
          FOR EACH ROW EXECUTE FUNCTION ${options.tasksTable}_workflow_version_immutable_fn();
      END IF;
    END
    $trigger$
  `);
}

export async function retireTaskboardResolutionSchema(
  options: Pick<TaskboardV2SchemaOptions, 'executionsTable'>,
  client: PoolClient,
): Promise<void> {
  const legacyResolutionsTable = options.executionsTable.endsWith('_taskboard_execs')
    ? options.executionsTable.replace(/_taskboard_execs$/, '_taskboard_resolutions')
    : options.executionsTable.endsWith('_executions')
      ? options.executionsTable.replace(/_executions$/, '_resolutions')
      : `${options.executionsTable}_resolutions`;
  await client.query('BEGIN');
  try {
    // Preserve the terminal fence for executions completed by the retired protocol.
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema=current_schema() AND table_name='${options.executionsTable}'
             AND column_name='resolution_id'
        ) AND EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema=current_schema() AND table_name='${options.executionsTable}'
             AND column_name='resolved_at'
        ) THEN
          UPDATE ${options.executionsTable}
             SET transitioned_at=COALESCE(transitioned_at,resolved_at),
                 terminal_reason_code=COALESCE(terminal_reason_code,'legacy_resolution_migrated')
           WHERE resolution_id IS NOT NULL;
        END IF;
      END $$
    `);
    // Immutable change history remains untouched.
    await client.query(`DROP TABLE IF EXISTS ${legacyResolutionsTable}`);
    await client.query(`
      ALTER TABLE ${options.executionsTable} DROP COLUMN IF EXISTS resolution_id;
      ALTER TABLE ${options.executionsTable} DROP COLUMN IF EXISTS resolved_at
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
