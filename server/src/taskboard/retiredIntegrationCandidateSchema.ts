import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

/** Permanently removes the retired Candidate control-plane schema in dependency order. */
export async function retireIntegrationCandidateSchema(
  integrationSourcesTable: string,
  client: Pick<PoolClient, 'query'>,
): Promise<void> {
  const root = integrationSourcesTable.endsWith('_sources')
    ? integrationSourcesTable.slice(0, -'_sources'.length)
    : integrationSourcesTable;
  const candidates = `${root}_candidates`;
  const revisions = `${root}_candidate_revisions`;
  const snapshots = `${root}_candidate_source_snapshots`;
  const providerOperations = `${root}_provider_operations_v3`;
  const requests = `${root}_requests_outbox_v3`;
  const heartbeats = `${root}_activation_heartbeats_v3`;
  const migrations = `${root}_candidate_schema_migrations_v3`;
  const revisionNamespace = createHash('sha256').update(revisions).digest('hex').slice(0, 12);

  // Requests/provider operations and snapshots/revisions reference the Candidate
  // aggregate. Drop dependants first; no CASCADE is used so an unknown live
  // dependency fails startup rather than being deleted accidentally.
  await client.query(`
    DROP TABLE IF EXISTS ${requests};
    DROP TABLE IF EXISTS ${providerOperations};
    DROP TABLE IF EXISTS ${snapshots};
    DROP TABLE IF EXISTS ${revisions};
    DROP TABLE IF EXISTS ${candidates};
    DROP TABLE IF EXISTS ${heartbeats};
    DROP TABLE IF EXISTS ${migrations};

    DROP FUNCTION IF EXISTS ${requests}_immutable_fn();
    DROP FUNCTION IF EXISTS ${providerOperations}_terminal_candidate_fn();
    DROP FUNCTION IF EXISTS ${candidates}_terminalize_prepared_operations_fn();
    DROP FUNCTION IF EXISTS ${candidates}_irreversible_state_fn();
    DROP FUNCTION IF EXISTS ${snapshots}_immutable_fn();
    DROP FUNCTION IF EXISTS ${revisions}_immutable_fn();
    DROP FUNCTION IF EXISTS tbv3_${revisionNamespace}_revision_immutable_fn();
  `);
}
