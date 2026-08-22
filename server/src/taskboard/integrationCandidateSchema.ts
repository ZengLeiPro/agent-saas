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
  activationHeartbeatsTable: string;
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
    activationHeartbeatsTable: `${root}_activation_heartbeats_v3`,
  };
}

async function installIntegrationCandidateSchemaV1(
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
    ALTER TABLE ${candidatesTable} ADD COLUMN IF NOT EXISTS worker_error TEXT;
    ALTER TABLE ${candidatesTable} ADD COLUMN IF NOT EXISTS worker_attempts INTEGER NOT NULL DEFAULT 0 CHECK (worker_attempts >= 0);
    ALTER TABLE ${candidatesTable} ADD COLUMN IF NOT EXISTS worker_available_at TIMESTAMPTZ NOT NULL DEFAULT now()
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION ${candidatesTable}_irreversible_state_fn()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF OLD.state='merged' AND NEW.state IS DISTINCT FROM OLD.state THEN
        RAISE EXCEPTION 'TASKBOARD_CANDIDATE_MERGED_IRREVERSIBLE';
      END IF;
      IF OLD.state='merging' AND NEW.state='canceled' THEN
        RAISE EXCEPTION 'TASKBOARD_CANDIDATE_MERGE_RECONCILIATION_REQUIRED';
      END IF;
      RETURN NEW;
    END
    $function$;
    DROP TRIGGER IF EXISTS ${candidatesTable}_irreversible_state ON ${candidatesTable};
    CREATE TRIGGER ${candidatesTable}_irreversible_state BEFORE UPDATE OF state ON ${candidatesTable}
      FOR EACH ROW EXECUTE FUNCTION ${candidatesTable}_irreversible_state_fn()
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
      subject_kind TEXT NOT NULL DEFAULT 'provider_subject' CHECK (subject_kind IN ('source_seed','provider_subject')),
      tree_oid TEXT,
      composition_complete BOOLEAN NOT NULL DEFAULT TRUE,
      source_set_digest TEXT NOT NULL,
      CHECK ((subject_kind='source_seed' AND tree_oid IS NULL)
        OR (subject_kind='provider_subject' AND tree_oid IS NOT NULL)),
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
    ALTER TABLE ${revisionsTable}
      ADD COLUMN IF NOT EXISTS subject_kind TEXT NOT NULL DEFAULT 'provider_subject'
        CHECK (subject_kind IN ('source_seed','provider_subject'));
    ALTER TABLE ${revisionsTable}
      ADD COLUMN IF NOT EXISTS composition_complete BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE ${revisionsTable} ALTER COLUMN tree_oid DROP NOT NULL
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION ${revisionsTable}_subject_kind_fn()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF NOT ((NEW.subject_kind='source_seed' AND NEW.tree_oid IS NULL)
        OR (NEW.subject_kind='provider_subject' AND NEW.tree_oid IS NOT NULL)) THEN
        RAISE EXCEPTION 'TASKBOARD_CANDIDATE_REVISION_SUBJECT_KIND_INVALID';
      END IF;
      RETURN NEW;
    END
    $function$;
    DROP TRIGGER IF EXISTS ${revisionsTable}_subject_kind ON ${revisionsTable};
    CREATE TRIGGER ${revisionsTable}_subject_kind BEFORE INSERT OR UPDATE ON ${revisionsTable}
      FOR EACH ROW EXECUTE FUNCTION ${revisionsTable}_subject_kind_fn()
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
    CREATE OR REPLACE FUNCTION ${sourceSnapshotsTable}_review_owner_fn()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM ${options.executionsTable} e
         WHERE e.id=NEW.review_execution_id AND e.task_id=NEW.delivery_task_id
           AND e.purpose='review' AND e.status='succeeded'
      ) THEN
        RAISE EXCEPTION 'TASKBOARD_CANDIDATE_SOURCE_REVIEW_OWNERSHIP_INVALID';
      END IF;
      RETURN NEW;
    END
    $function$;
    DROP TRIGGER IF EXISTS ${sourceSnapshotsTable}_review_owner ON ${sourceSnapshotsTable};
    CREATE TRIGGER ${sourceSnapshotsTable}_review_owner BEFORE INSERT ON ${sourceSnapshotsTable}
      FOR EACH ROW EXECUTE FUNCTION ${sourceSnapshotsTable}_review_owner_fn()
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${providerOperationsTable} (
      id TEXT PRIMARY KEY,
      operation_key TEXT NOT NULL UNIQUE,
      intent_digest TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('create_branch','create_pull_request','update_ref','push_ref','merge_pull_request','close_source_pull_request','comment_source_pull_request')),
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
    ALTER TABLE ${providerOperationsTable}
      DROP CONSTRAINT IF EXISTS ${providerOperationsTable}_kind_check;
    ALTER TABLE ${providerOperationsTable}
      ADD CONSTRAINT ${providerOperationsTable}_kind_check
      CHECK (kind IN ('create_branch','create_pull_request','update_ref','push_ref','merge_pull_request','close_source_pull_request','comment_source_pull_request'))
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


const INTEGRATION_CANDIDATE_SCHEMA_MIGRATIONS = [
  { version: 1, name: 'candidate_v3_expand_base', run: installIntegrationCandidateSchemaV1 },
  {
    version: 2,
    name: 'cleanup_action_receipt',
    run: async (options: IntegrationCandidateSchemaOptions, client: Pick<PoolClient, 'query'>) => {
      const { requestsOutboxTable } = integrationCandidateTableNames(options.integrationSourcesTable);
      await client.query(`ALTER TABLE ${requestsOutboxTable} ADD COLUMN IF NOT EXISTS receipt JSONB`);
    },
  },
  {
    version: 3,
    name: 'runtime_activation_heartbeat',
    run: async (options: IntegrationCandidateSchemaOptions, client: Pick<PoolClient, 'query'>) => {
      const { activationHeartbeatsTable } = integrationCandidateTableNames(options.integrationSourcesTable);
      await client.query(`CREATE TABLE IF NOT EXISTS ${activationHeartbeatsTable} (
        process_identity TEXT PRIMARY KEY,
        release_identity TEXT NOT NULL,
        process_role TEXT NOT NULL CHECK (process_role IN ('all','runtime-worker')),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        protocol_version INTEGER NOT NULL CHECK (protocol_version > 0),
        policy_revision TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('healthy','unhealthy','inactive')),
        reason TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${activationHeartbeatsTable}_fresh_idx
        ON ${activationHeartbeatsTable}(updated_at DESC) WHERE status='healthy'`);
    },
  },
  {
    version: 4,
    name: 'cancel_prepared_provider_operations',
    run: async (options: IntegrationCandidateSchemaOptions, client: Pick<PoolClient, 'query'>) => {
      const { candidatesTable, providerOperationsTable } = integrationCandidateTableNames(options.integrationSourcesTable);
      await client.query(`UPDATE ${providerOperationsTable} o
        SET state='failed',error='Candidate canceled before provider execution',updated_at=now()
        FROM ${candidatesTable} c
        WHERE o.candidate_id=c.id AND c.state='canceled' AND o.state='prepared'`);
    },
  },
  {
    version: 5,
    name: 'terminalize_unexecuted_provider_operations',
    run: async (options: IntegrationCandidateSchemaOptions, client: Pick<PoolClient, 'query'>) => {
      const { candidatesTable, providerOperationsTable } = integrationCandidateTableNames(options.integrationSourcesTable);
      await client.query(`
        LOCK TABLE ${candidatesTable},${providerOperationsTable} IN SHARE ROW EXCLUSIVE MODE;
        CREATE OR REPLACE FUNCTION ${providerOperationsTable}_terminal_candidate_fn()
        RETURNS TRIGGER LANGUAGE plpgsql AS $function$
        BEGIN
          PERFORM 1 FROM ${candidatesTable} c
            WHERE c.id=NEW.candidate_id AND c.state NOT IN ('merged','canceled') FOR UPDATE;
          IF NOT FOUND THEN RAISE EXCEPTION 'TASKBOARD_CANDIDATE_PROVIDER_OPERATION_TERMINAL'; END IF;
          RETURN NEW;
        END
        $function$;
        DROP TRIGGER IF EXISTS ${providerOperationsTable}_terminal_candidate ON ${providerOperationsTable};
        CREATE TRIGGER ${providerOperationsTable}_terminal_candidate BEFORE INSERT ON ${providerOperationsTable}
          FOR EACH ROW EXECUTE FUNCTION ${providerOperationsTable}_terminal_candidate_fn();
        CREATE OR REPLACE FUNCTION ${candidatesTable}_terminalize_prepared_operations_fn()
        RETURNS TRIGGER LANGUAGE plpgsql AS $function$
        BEGIN
          UPDATE ${providerOperationsTable}
             SET state='failed',error='Terminal candidate cleanup found unexecuted provider operation',
                 receipt=jsonb_build_object('outcome','not_applied','evidence','attempt_count=0'),updated_at=now()
           WHERE candidate_id=NEW.id AND state='prepared' AND attempt_count=0;
          RETURN NEW;
        END
        $function$;
        DROP TRIGGER IF EXISTS ${candidatesTable}_terminalize_prepared_operations ON ${candidatesTable};
        CREATE TRIGGER ${candidatesTable}_terminalize_prepared_operations
          AFTER UPDATE OF state ON ${candidatesTable}
          FOR EACH ROW WHEN (NEW.state IN ('merged','canceled') AND OLD.state IS DISTINCT FROM NEW.state)
          EXECUTE FUNCTION ${candidatesTable}_terminalize_prepared_operations_fn();
        UPDATE ${providerOperationsTable} o
           SET state='failed',error='Terminal candidate cleanup found unexecuted provider operation',
               receipt=jsonb_build_object('outcome','not_applied','evidence','attempt_count=0'),updated_at=now()
          FROM ${candidatesTable} c
         WHERE o.candidate_id=c.id AND c.state IN ('merged','canceled')
           AND o.state='prepared' AND o.attempt_count=0
      `);
    },
  },
  {
    version: 6,
    name: 'track_incomplete_composition_subjects',
    run: async (options: IntegrationCandidateSchemaOptions, client: Pick<PoolClient, 'query'>) => {
      const { revisionsTable } = integrationCandidateTableNames(options.integrationSourcesTable);
      await client.query(`
        ALTER TABLE ${revisionsTable}
          ADD COLUMN IF NOT EXISTS composition_complete BOOLEAN NOT NULL DEFAULT TRUE;
        DROP TRIGGER IF EXISTS ${revisionsTable}_immutable_update ON ${revisionsTable};
        CREATE OR REPLACE FUNCTION ${revisionsTable}_source_seed_incomplete_fn()
        RETURNS TRIGGER LANGUAGE plpgsql AS $function$
        BEGIN
          IF NEW.subject_kind='source_seed' THEN NEW.composition_complete:=FALSE; END IF;
          RETURN NEW;
        END
        $function$;
        DROP TRIGGER IF EXISTS ${revisionsTable}_source_seed_incomplete ON ${revisionsTable};
        CREATE TRIGGER ${revisionsTable}_source_seed_incomplete
          BEFORE INSERT OR UPDATE OF subject_kind,composition_complete ON ${revisionsTable}
          FOR EACH ROW EXECUTE FUNCTION ${revisionsTable}_source_seed_incomplete_fn();
        UPDATE ${revisionsTable}
           SET composition_complete=FALSE
         WHERE subject_kind='source_seed' AND composition_complete IS DISTINCT FROM FALSE;
        CREATE TRIGGER ${revisionsTable}_immutable_update BEFORE UPDATE ON ${revisionsTable}
          FOR EACH ROW EXECUTE FUNCTION ${revisionsTable}_immutable_fn()
      `);
    },
  },
] as const;

/**
 * Versioned, transactional expand installer. The advisory lock serializes replicas during rollout;
 * timeouts keep startup from waiting indefinitely behind application traffic.
 */
export async function runIntegrationCandidateSchema(
  options: IntegrationCandidateSchemaOptions,
  client: Pick<PoolClient, 'query'>,
): Promise<void> {
  const root = options.integrationSourcesTable.endsWith('_sources')
    ? options.integrationSourcesTable.slice(0, -'_sources'.length)
    : options.integrationSourcesTable;
  const migrationsTable = `${root}_candidate_schema_migrations_v3`;
  await client.query(`CREATE TABLE IF NOT EXISTS ${migrationsTable} (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  for (const migration of INTEGRATION_CANDIDATE_SCHEMA_MIGRATIONS) {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await client.query(`SET LOCAL statement_timeout = '60s'`);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${migrationsTable}:install`]);
      const applied = await client.query(`SELECT version FROM ${migrationsTable} WHERE version=$1`, [migration.version]);
      if (!applied.rows[0]) {
        await migration.run(options, client);
        await client.query(
          `INSERT INTO ${migrationsTable}(version,name) VALUES ($1,$2) ON CONFLICT (version) DO NOTHING`,
          [migration.version, migration.name],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}
