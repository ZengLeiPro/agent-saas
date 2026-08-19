import type { Pool } from 'pg';

import type {
  IntegrationProviderOperationRecord,
  IntegrationProviderOperationState,
  IntegrationProviderOperationStorageHost,
} from './integrationProviderOperations.js';

export interface IntegrationEngineV3PostgresOptions {
  pool: Pick<Pool, 'query'>;
  providerOperationsTable: string;
}

/** Durable PostgreSQL implementation of the v3 provider operation ledger. */
export class PostgresIntegrationProviderOperationStorage implements IntegrationProviderOperationStorageHost {
  constructor(private readonly options: IntegrationEngineV3PostgresOptions) {}

  async getByOperationKey(operationKey: string): Promise<IntegrationProviderOperationRecord | undefined> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.options.providerOperationsTable} WHERE operation_key=$1`,
      [operationKey],
    );
    return result.rows[0] ? rowToProviderOperation(result.rows[0]) : undefined;
  }

  async insertPrepared(record: IntegrationProviderOperationRecord): Promise<IntegrationProviderOperationRecord> {
    const result = await this.options.pool.query(
      `INSERT INTO ${this.options.providerOperationsTable}
        (id,operation_key,intent_digest,kind,repository_id,candidate_id,candidate_revision,
         workflow_epoch,lane_epoch,execution_id,expected,command,state,attempt_count,receipt,error,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15::jsonb,$16,$17,$18)
       ON CONFLICT (operation_key) DO NOTHING RETURNING *`,
      [record.id, record.operationKey, record.intentDigest, record.kind, record.repositoryId,
        record.fence.candidateId, record.fence.candidateRevision, record.fence.workflowEpoch,
        record.fence.laneEpoch, record.fence.executionId, JSON.stringify(record.expected),
        JSON.stringify(record.command), record.state, record.attemptCount,
        record.receipt ? JSON.stringify(record.receipt) : null, record.error ?? null,
        record.createdAt, record.updatedAt],
    );
    if (result.rows[0]) return rowToProviderOperation(result.rows[0]);
    const winner = await this.getByOperationKey(record.operationKey);
    if (!winner) throw new Error('Provider operation insert race produced no winning row');
    return winner;
  }

  async compareAndSet(input: {
    id: string;
    expectedState: IntegrationProviderOperationState;
    nextState: IntegrationProviderOperationState;
    patch: Pick<IntegrationProviderOperationRecord, 'attemptCount' | 'updatedAt'> & {
      receipt?: Record<string, unknown>;
      error?: string;
    };
  }): Promise<IntegrationProviderOperationRecord | undefined> {
    const result = await this.options.pool.query(
      `UPDATE ${this.options.providerOperationsTable}
          SET state=$3,attempt_count=$4,updated_at=$5,
              receipt=CASE WHEN $6::boolean THEN $7::jsonb ELSE receipt END,
              error=CASE WHEN $8::boolean THEN $9 ELSE error END
        WHERE id=$1 AND state=$2 RETURNING *`,
      [input.id, input.expectedState, input.nextState, input.patch.attemptCount, input.patch.updatedAt,
        input.patch.receipt !== undefined, input.patch.receipt === undefined ? null : JSON.stringify(input.patch.receipt),
        input.patch.error !== undefined, input.patch.error ?? null],
    );
    return result.rows[0] ? rowToProviderOperation(result.rows[0]) : undefined;
  }
}

export function rowToProviderOperation(row: Record<string, unknown>): IntegrationProviderOperationRecord {
  return {
    id: String(row.id),
    operationKey: String(row.operation_key),
    intentDigest: String(row.intent_digest),
    kind: String(row.kind) as IntegrationProviderOperationRecord['kind'],
    repositoryId: String(row.repository_id),
    fence: {
      candidateId: String(row.candidate_id),
      candidateRevision: Number(row.candidate_revision),
      workflowEpoch: Number(row.workflow_epoch),
      laneEpoch: Number(row.lane_epoch),
      executionId: String(row.execution_id),
    },
    expected: asRecord(row.expected),
    command: asRecord(row.command),
    state: String(row.state) as IntegrationProviderOperationState,
    attemptCount: Number(row.attempt_count),
    ...(row.receipt == null ? {} : { receipt: asRecord(row.receipt) }),
    ...(row.error == null ? {} : { error: String(row.error) }),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function toIso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
