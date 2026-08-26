import type { PoolClient } from 'pg';

/** Database surface shared by Agent-first integration merge finalization and delivery reconciliation. */
export interface IntegrationFinalizationHost {
  pool: { connect(): Promise<PoolClient> };
  tasksTable: string;
  commentsTable: string;
  executionsTable: string;
  changesTable: string;
  integrationLanesTable: string;
  integrationSourcesTable: string;
  mergeAuthorizationsTable: string;
  mergeOperationsTable: string;
  blockEpisodesTable: string;
  remediationAttemptsTable: string;
  cancellationOutboxTable: string;
}
