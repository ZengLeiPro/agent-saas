import type { PoolClient } from 'pg';

/**
 * The integration agent owns process state; GitHub owns code state.  This table is
 * intentionally a small rendezvous record, not a second PR/revision state machine.
 */
export interface IntegrationAgentSchemaOptions {
  tasksTable: string;
  integrationSourcesTable: string;
}

export interface IntegrationAgentTableNames { agentsTable: string; }

export function integrationAgentTableNames(integrationSourcesTable: string): IntegrationAgentTableNames {
  const root = integrationSourcesTable.endsWith('_sources')
    ? integrationSourcesTable.slice(0, -'_sources'.length)
    : integrationSourcesTable;
  return { agentsTable: `${root}_agents` };
}

export async function runIntegrationAgentSchema(
  options: IntegrationAgentSchemaOptions,
  client: Pick<PoolClient, 'query'>,
): Promise<void> {
  const { agentsTable } = integrationAgentTableNames(options.integrationSourcesTable);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${agentsTable} (
      integration_task_id TEXT PRIMARY KEY REFERENCES ${options.tasksTable}(id) ON DELETE CASCADE,
      delivery_source_ids JSONB NOT NULL,
      repository_id TEXT NOT NULL,
      durable_session_id TEXT,
      integration_branch TEXT NOT NULL,
      provider_pull_request_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('active','reviewing','ready_to_merge','merged','canceled')),
      review_head_oid TEXT,
      verdict TEXT CHECK (verdict IN ('approved','changes_requested')),
      review_execution_id TEXT,
      merge_in_flight_execution_id TEXT,
      merge_in_flight_review_execution_id TEXT,
      merge_in_flight_review_head_oid TEXT,
      merge_receipt JSONB,
      cleanup_receipt JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((verdict IS NULL AND review_execution_id IS NULL) OR (review_head_oid IS NOT NULL))
    )
  `);
  await client.query(`ALTER TABLE ${agentsTable} ADD COLUMN IF NOT EXISTS merge_in_flight_execution_id TEXT`);
  await client.query(`ALTER TABLE ${agentsTable} ADD COLUMN IF NOT EXISTS merge_in_flight_review_execution_id TEXT`);
  await client.query(`ALTER TABLE ${agentsTable} ADD COLUMN IF NOT EXISTS merge_in_flight_review_head_oid TEXT`);
  await client.query(`ALTER TABLE ${agentsTable} ADD COLUMN IF NOT EXISTS merge_receipt JSONB`);
  await client.query(`ALTER TABLE ${agentsTable} ADD COLUMN IF NOT EXISTS cleanup_receipt JSONB`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${agentsTable}_active_idx ON ${agentsTable}(status) WHERE status IN ('active','reviewing','ready_to_merge')`);
}
