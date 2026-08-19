import type { PoolClient } from 'pg';

export interface IntegrationCandidateSchemaOptions {
  tasksTable: string;
  executionsTable: string;
  integrationSourcesTable: string;
}

export interface IntegrationCandidateTableNames {
  candidatesTable: string;
  revisionsTable: string;
  sourceSnapshotsTable: string;
  providerOperationsTable: string;
  requestsOutboxTable: string;
}

export function integrationCandidateTableNames(integrationSourcesTable: string): IntegrationCandidateTableNames {
  const root = integrationSourcesTable.endsWith('_sources')
    ? integrationSourcesTable.slice(0, -'_sources'.length)
    : integrationSourcesTable;
  return {
    candidatesTable: `${root}_candidates`,
    revisionsTable: `${root}_candidate_revisions`,
    sourceSnapshotsTable: `${root}_candidate_source_snapshots`,
    providerOperationsTable: `${root}_provider_operations_v3`,
    requestsOutboxTable: `${root}_requests_outbox_v3`,
  };
}

export async function runIntegrationCandidateSchema(
  options: IntegrationCandidateSchemaOptions,
  client: Pick<PoolClient, 'query'>,
): Promise<void> {
  const { candidatesTable, revisionsTable, sourceSnapshotsTable, providerOperationsTable, requestsOutboxTable } = integrationCandidateTableNames(
    options.integrationSourcesTable,
  );

  await client.query(`
    ALTER TABLE ${options.tasksTable}
      ADD COLUMN IF NOT EXISTS workflow_version SMALLINT NOT NULL DEFAULT 2
      CHECK (workflow_version IN (2, 3))
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION ${options.tasksTable}_workflow_version_immutable_fn()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.workflow_version IS DISTINCT FROM OLD.workflow_version THEN
        RAISE EXCEPTION 'TASKBOARD_WORKFLOW_VERSION_IMMUTABLE';
      END IF;
      RETURN NEW;
    END
    $function$;
    DROP TRIGGER IF EXISTS ${options.tasksTable}_workflow_version_immutable ON ${options.tasksTable};
    CREATE TRIGGER ${options.tasksTable}_workflow_version_immutable
      BEFORE UPDATE OF workflow_version ON ${options.tasksTable}
      FOR EACH ROW EXECUTE FUNCTION ${options.tasksTable}_workflow_version_immutable_fn()
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${candidatesTable} (
      id TEXT PRIMARY KEY,
      integration_task_id TEXT NOT NULL UNIQUE REFERENCES ${options.tasksTable}(id) ON DELETE CASCADE,
      repository_id TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      branch TEXT NOT NULL,
      provider_pull_request_id TEXT,
      state TEXT NOT NULL DEFAULT 'preparing'
        CHECK (state IN ('preparing','composing','waiting_checks','needs_work','working','in_review','approved','merging','merged','blocked','needs_human','canceled')),
      current_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
      work_round INTEGER NOT NULL DEFAULT 0 CHECK (work_round >= 0),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      workflow_epoch BIGINT NOT NULL,
      lane_epoch BIGINT NOT NULL,
      policy_revision TEXT NOT NULL,
      merge_method TEXT NOT NULL CHECK (merge_method IN ('merge','squash','rebase')),
      policy_snapshot JSONB NOT NULL,
      source_set_digest TEXT,
      approved_revision INTEGER,
      approved_review_execution_id TEXT REFERENCES ${options.executionsTable}(id),
      merged_commit_oid TEXT,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((approved_revision IS NULL) = (approved_review_execution_id IS NULL)),
      CHECK (approved_revision IS NULL OR approved_revision = current_revision),
      CHECK (state <> 'merged' OR merged_commit_oid IS NOT NULL)
    )
  `);
  await client.query(`
    ALTER TABLE ${candidatesTable}
      ADD COLUMN IF NOT EXISTS worker_status TEXT NOT NULL DEFAULT 'idle'
        CHECK (worker_status IN ('idle','processing','failed'));
    ALTER TABLE ${candidatesTable} ADD COLUMN IF NOT EXISTS worker_lease_id TEXT;
    ALTER TABLE ${candidatesTable} ADD COLUMN IF NOT EXISTS worker_lease_expires_at TIMESTAMPTZ;
    ALTER TABLE ${candidatesTable} ADD COLUMN IF NOT EXISTS worker_checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE ${candidatesTable} ADD COLUMN IF NOT EXISTS worker_error TEXT
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${candidatesTable}_repository_branch_uidx
      ON ${candidatesTable}(repository_id, branch);
    CREATE UNIQUE INDEX IF NOT EXISTS ${candidatesTable}_repository_pr_uidx
      ON ${candidatesTable}(repository_id, provider_pull_request_id)
      WHERE provider_pull_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ${candidatesTable}_state_updated_idx
      ON ${candidatesTable}(state, updated_at)
      WHERE state NOT IN ('merged','canceled');
    CREATE INDEX IF NOT EXISTS ${candidatesTable}_worker_idx
      ON ${candidatesTable}(updated_at)
      WHERE worker_status<>'failed'
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${revisionsTable} (
      candidate_id TEXT NOT NULL REFERENCES ${candidatesTable}(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      digest_version SMALLINT NOT NULL CHECK (digest_version = 1),
      base_oid TEXT NOT NULL,
      head_oid TEXT NOT NULL,
      tree_oid TEXT NOT NULL,
      source_set_digest TEXT NOT NULL,
      subject_digest TEXT NOT NULL,
      policy_snapshot_digest TEXT NOT NULL,
      policy_revision TEXT NOT NULL,
      merge_method TEXT NOT NULL CHECK (merge_method IN ('merge','squash','rebase')),
      work_round INTEGER NOT NULL CHECK (work_round >= 0),
      work_execution_id TEXT REFERENCES ${options.executionsTable}(id),
      review_execution_id TEXT REFERENCES ${options.executionsTable}(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (candidate_id, revision),
      UNIQUE (candidate_id, subject_digest)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${sourceSnapshotsTable} (
      candidate_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      source_order INTEGER NOT NULL CHECK (source_order >= 0),
      integration_source_id TEXT NOT NULL REFERENCES ${options.integrationSourcesTable}(id),
      delivery_task_id TEXT NOT NULL REFERENCES ${options.tasksTable}(id),
      delivery_task_version INTEGER NOT NULL CHECK (delivery_task_version > 0),
      repository_id TEXT NOT NULL,
      provider_pull_request_id TEXT NOT NULL,
      frozen_head_oid TEXT NOT NULL,
      frozen_base_oid TEXT NOT NULL,
      reviewed_subject_digest TEXT NOT NULL,
      review_execution_id TEXT NOT NULL REFERENCES ${options.executionsTable}(id),
      review_receipt_digest TEXT NOT NULL,
      requirement_digest TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (candidate_id, revision, source_order),
      UNIQUE (candidate_id, revision, integration_source_id),
      FOREIGN KEY (candidate_id, revision)
        REFERENCES ${revisionsTable}(candidate_id, revision) ON DELETE CASCADE
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${providerOperationsTable} (
      id TEXT PRIMARY KEY,
      operation_key TEXT NOT NULL UNIQUE,
      intent_digest TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('create_branch','create_pull_request','update_ref','merge_pull_request','close_source_pull_request','comment_source_pull_request')),
      repository_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL REFERENCES ${candidatesTable}(id),
      candidate_revision INTEGER NOT NULL CHECK (candidate_revision > 0),
      workflow_epoch BIGINT NOT NULL,
      lane_epoch BIGINT NOT NULL,
      execution_id TEXT NOT NULL,
      expected JSONB NOT NULL,
      command JSONB NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared','executing','succeeded','unknown','failed','needs_human')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      receipt JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (candidate_id,candidate_revision)
        REFERENCES ${revisionsTable}(candidate_id,revision)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${providerOperationsTable}_reconcile_idx
      ON ${providerOperationsTable}(updated_at)
      WHERE state IN ('executing','unknown')
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${requestsOutboxTable} (
      id TEXT PRIMARY KEY,
      request_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('work','review','cleanup','workspace_sync')),
      candidate_id TEXT NOT NULL REFERENCES ${candidatesTable}(id),
      candidate_revision INTEGER NOT NULL CHECK (candidate_revision > 0),
      work_round INTEGER NOT NULL DEFAULT 0 CHECK (work_round >= 0),
      workflow_epoch BIGINT NOT NULL,
      lane_epoch BIGINT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      lease_id TEXT,
      lease_expires_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (candidate_id,candidate_revision)
        REFERENCES ${revisionsTable}(candidate_id,revision)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${requestsOutboxTable}_pending_idx
      ON ${requestsOutboxTable}(available_at,created_at)
      WHERE status IN ('pending','processing')
  `);
  for (const table of [revisionsTable, sourceSnapshotsTable]) {
    await client.query(`
      CREATE OR REPLACE FUNCTION ${table}_immutable_fn()
      RETURNS trigger LANGUAGE plpgsql AS $function$
      BEGIN
        RAISE EXCEPTION 'TASKBOARD_CANDIDATE_SNAPSHOT_IMMUTABLE';
      END
      $function$;
      DROP TRIGGER IF EXISTS ${table}_immutable_update ON ${table};
      CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION ${table}_immutable_fn();
      DROP TRIGGER IF EXISTS ${table}_immutable_delete ON ${table};
      CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION ${table}_immutable_fn()
    `);
  }
}
