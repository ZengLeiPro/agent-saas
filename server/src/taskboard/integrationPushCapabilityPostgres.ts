import type { Pool, PoolClient } from 'pg';

import {
  type IntegrationPushCapabilityBinding,
  type IntegrationPushCapabilityHost,
  type IntegrationPushCapabilityHostResult,
  type IntegrationPushCapabilityRecord,
  type IntegrationPushFence,
  validateExactIntegrationRef,
} from './integrationPushCapability.js';

export interface PostgresIntegrationPushCapabilityOptions {
  pool: Pick<Pool, 'connect' | 'query'>;
  capabilitiesTable: string;
  fencesTable: string;
  boardsTable: string;
  tasksTable: string;
  executionsTable: string;
  candidatesTable: string;
  revisionsTable: string;
}

export interface AuthoritativeIntegrationPushTarget {
  binding: IntegrationPushCapabilityBinding;
  ownerUserId: string;
}

/**
 * Production capability host. Every admission operation locks and re-checks the
 * execution, candidate and fence rows in the same transaction as the capability write.
 */
export class PostgresIntegrationPushCapabilityHost implements IntegrationPushCapabilityHost {
  constructor(private readonly options: PostgresIntegrationPushCapabilityOptions) {}

  async resolveTarget(input: {
    tenantId: string;
    executionId: string;
    candidateId: string;
  }): Promise<AuthoritativeIntegrationPushTarget | undefined> {
    const result = await this.options.pool.query(this.authoritativeTargetSql(false, true), [
      input.executionId,
      input.candidateId,
      input.tenantId,
    ]);
    return result.rows[0] ? this.rowToTarget(result.rows[0]) : undefined;
  }

  async resolveExecutionTarget(input: {
    tenantId: string;
    executionId: string;
  }): Promise<AuthoritativeIntegrationPushTarget | undefined> {
    const result = await this.options.pool.query(this.authoritativeTargetSql(false, false, true), [
      input.executionId,
      input.tenantId,
    ]);
    return result.rows[0] ? this.rowToTarget(result.rows[0]) : undefined;
  }

  async issueActive(record: IntegrationPushCapabilityRecord): Promise<IntegrationPushCapabilityHostResult> {
    return this.transaction(async (client) => {
      const authoritative = await this.resolveTargetWithClient(client, record.binding, true);
      if (!authoritative || !sameBinding(authoritative.binding, record.binding)) return { ok: false, reason: 'fenced' };
      const fence = await client.query(
        `SELECT * FROM ${this.options.fencesTable}
          WHERE tenant_id=$1 AND repository_id=$2 AND integration_task_id=$3 FOR UPDATE`,
        [record.binding.tenantId, record.binding.repositoryId, record.binding.integrationTaskId],
      );
      if (!fence.rows[0] || !matchesFenceRow(record.binding, fence.rows[0])) {
        return { ok: false, reason: 'fenced' };
      }
      const inserted = await client.query(
        `INSERT INTO ${this.options.capabilitiesTable}
          (id,secret_hash,tenant_id,repository_id,integration_task_id,candidate_id,revision,
           execution_id,exact_ref,expected_old_oid,expected_base_oid,lane_epoch,workflow_epoch,issued_at,expires_at,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active')
         ON CONFLICT (id) DO NOTHING RETURNING *`,
        [record.id, record.secretHash, record.binding.tenantId, record.binding.repositoryId,
          record.binding.integrationTaskId, record.binding.candidateId, record.binding.revision,
          record.binding.executionId, record.binding.exactRef, record.binding.expectedOldOid,
          record.binding.expectedBaseOid, record.binding.laneEpoch, record.binding.workflowEpoch,
          record.issuedAt, record.expiresAt],
      );
      return inserted.rows[0]
        ? { ok: true, record: rowToRecord(inserted.rows[0]) }
        : { ok: false, reason: 'already_exists' };
    });
  }

  async findById(id: string): Promise<IntegrationPushCapabilityRecord | undefined> {
    const result = await this.options.pool.query(`SELECT * FROM ${this.options.capabilitiesTable} WHERE id=$1`, [id]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  }

  async consumeActive(input: {
    id: string;
    secretHash: string;
    now: string;
    binding: IntegrationPushCapabilityBinding;
  }): Promise<IntegrationPushCapabilityHostResult> {
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT * FROM ${this.options.capabilitiesTable} WHERE id=$1 FOR UPDATE`,
        [input.id],
      );
      const row = selected.rows[0];
      if (!row) return { ok: false, reason: 'not_found' };
      if (String(row.secret_hash) !== input.secretHash) return { ok: false, reason: 'invalid_token' };
      if (row.status === 'consumed') return { ok: false, reason: 'already_consumed' };
      if (row.status === 'revoked') return { ok: false, reason: 'revoked' };
      if (Date.parse(toIso(row.expires_at)) <= Date.parse(input.now)) return { ok: false, reason: 'expired' };
      const stored = rowToRecord(row);
      if (!sameBinding(stored.binding, input.binding)) return { ok: false, reason: 'fenced' };
      const authoritative = await this.resolveTargetWithClient(client, stored.binding, true);
      if (!authoritative || !sameBinding(authoritative.binding, stored.binding)) return { ok: false, reason: 'fenced' };
      const fence = await client.query(
        `SELECT * FROM ${this.options.fencesTable}
          WHERE tenant_id=$1 AND repository_id=$2 AND integration_task_id=$3 FOR UPDATE`,
        [stored.binding.tenantId, stored.binding.repositoryId, stored.binding.integrationTaskId],
      );
      if (!fence.rows[0] || !matchesFenceRow(stored.binding, fence.rows[0])) return { ok: false, reason: 'fenced' };
      const updated = await client.query(
        `UPDATE ${this.options.capabilitiesTable}
            SET status='consumed',consumed_at=$2
          WHERE id=$1 AND status='active' RETURNING *`,
        [input.id, input.now],
      );
      return updated.rows[0]
        ? { ok: true, record: rowToRecord(updated.rows[0]) }
        : { ok: false, reason: 'already_consumed' };
    });
  }

  async revoke(input: { id: string; now: string; reason: string }): Promise<IntegrationPushCapabilityHostResult> {
    const result = await this.options.pool.query(
      `UPDATE ${this.options.capabilitiesTable}
          SET status='revoked',revoked_at=$2,revoke_reason=$3
        WHERE id=$1 AND status='active' RETURNING *`,
      [input.id, input.now, input.reason],
    );
    if (result.rows[0]) return { ok: true, record: rowToRecord(result.rows[0]) };
    const existing = await this.findById(input.id);
    if (!existing) return { ok: false, reason: 'not_found' };
    return { ok: false, reason: existing.status === 'consumed' ? 'already_consumed' : 'revoked' };
  }

  async fence(input: { fence: IntegrationPushFence; now: string; reason: string }): Promise<number> {
    return this.transaction(async (client) => {
      const current = await client.query(
        `SELECT * FROM ${this.options.fencesTable}
          WHERE tenant_id=$1 AND repository_id=$2 AND integration_task_id=$3 FOR UPDATE`,
        [input.fence.tenantId, input.fence.repositoryId, input.fence.integrationTaskId],
      );
      if (current.rows[0] && fenceMovesBackwards(input.fence, current.rows[0])) {
        throw new Error('Integration push fence cannot move backwards or re-enable without a new epoch');
      }
      await client.query(
        `INSERT INTO ${this.options.fencesTable}
          (tenant_id,repository_id,integration_task_id,candidate_id,revision,lane_epoch,workflow_epoch,enabled,reason,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (tenant_id,repository_id,integration_task_id) DO UPDATE SET
           candidate_id=EXCLUDED.candidate_id,revision=EXCLUDED.revision,lane_epoch=EXCLUDED.lane_epoch,
           workflow_epoch=EXCLUDED.workflow_epoch,enabled=EXCLUDED.enabled,reason=EXCLUDED.reason,updated_at=EXCLUDED.updated_at`,
        [input.fence.tenantId, input.fence.repositoryId, input.fence.integrationTaskId,
          input.fence.candidateId, input.fence.revision, input.fence.laneEpoch,
          input.fence.workflowEpoch, input.fence.enabled, input.reason, input.now],
      );
      const revoked = await client.query(
        `UPDATE ${this.options.capabilitiesTable}
            SET status='revoked',revoked_at=$4,revoke_reason=$5
          WHERE tenant_id=$1 AND repository_id=$2 AND integration_task_id=$3 AND status='active'
            AND (candidate_id<>$6 OR revision<>$7 OR lane_epoch<>$8 OR workflow_epoch<>$9 OR NOT $10::boolean)`,
        [input.fence.tenantId, input.fence.repositoryId, input.fence.integrationTaskId, input.now,
          input.reason, input.fence.candidateId, input.fence.revision, input.fence.laneEpoch,
          input.fence.workflowEpoch, input.fence.enabled],
      );
      return revoked.rowCount ?? 0;
    });
  }

  private async resolveTargetWithClient(
    client: Pick<PoolClient, 'query'>,
    binding: IntegrationPushCapabilityBinding,
    lock: boolean,
  ): Promise<AuthoritativeIntegrationPushTarget | undefined> {
    const result = await client.query(this.authoritativeTargetSql(lock, true), [
      binding.executionId,
      binding.candidateId,
      binding.tenantId,
    ]);
    return result.rows[0] ? this.rowToTarget(result.rows[0]) : undefined;
  }

  private authoritativeTargetSql(lock: boolean, bindCandidate: boolean, workOnly = false): string {
    const tenantParameter = bindCandidate ? '$3' : '$2';
    const candidatePredicate = bindCandidate ? ' AND c.id=$2' : '';
    const purposePredicate = workOnly ? "e.purpose='work'" : "e.purpose IN ('work','review')";
    return `SELECT e.id AS execution_id,e.candidate_revision,e.candidate_lane_epoch,e.candidate_workflow_epoch,
                   c.id AS candidate_id,c.integration_task_id,c.repository_id,c.branch,c.current_revision,
                   c.lane_epoch,c.workflow_epoch,r.head_oid,r.base_oid,b.tenant_id,b.owner_user_id
              FROM ${this.options.executionsTable} e
              JOIN ${this.options.tasksTable} t ON t.id=e.task_id
              JOIN ${this.options.boardsTable} b ON b.id=t.board_id
              JOIN ${this.options.candidatesTable} c ON c.id=e.candidate_id AND c.integration_task_id=t.id
              JOIN ${this.options.revisionsTable} r ON r.candidate_id=c.id AND r.revision=c.current_revision
             WHERE e.id=$1${candidatePredicate} AND b.tenant_id=${tenantParameter}
               AND t.workflow_version=3 AND t.kind='integration'
               AND ${purposePredicate}
               AND e.status IN ('queued','running','waiting_user','waiting_approval')
               AND c.state NOT IN ('merged','canceled','blocked','needs_human')
               AND e.candidate_revision=c.current_revision
               AND e.candidate_lane_epoch=c.lane_epoch
               AND e.candidate_workflow_epoch=c.workflow_epoch${lock ? ' FOR UPDATE OF e,c' : ''}`;
  }

  private rowToTarget(row: Record<string, unknown>): AuthoritativeIntegrationPushTarget {
    const exactRef = `refs/heads/${String(row.branch)}`;
    validateExactIntegrationRef(exactRef);
    return {
      binding: {
        tenantId: String(row.tenant_id),
        repositoryId: String(row.repository_id),
        integrationTaskId: String(row.integration_task_id),
        candidateId: String(row.candidate_id),
        revision: Number(row.current_revision),
        executionId: String(row.execution_id),
        exactRef,
        expectedOldOid: String(row.head_oid),
        expectedBaseOid: String(row.base_oid),
        laneEpoch: Number(row.lane_epoch),
        workflowEpoch: Number(row.workflow_epoch),
      },
      ownerUserId: String(row.owner_user_id),
    };
  }

  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function rowToRecord(row: Record<string, unknown>): IntegrationPushCapabilityRecord {
  return {
    id: String(row.id),
    secretHash: String(row.secret_hash),
    binding: {
      tenantId: String(row.tenant_id), repositoryId: String(row.repository_id),
      integrationTaskId: String(row.integration_task_id), candidateId: String(row.candidate_id),
      revision: Number(row.revision), executionId: String(row.execution_id), exactRef: String(row.exact_ref),
      expectedOldOid: String(row.expected_old_oid), expectedBaseOid: String(row.expected_base_oid),
      laneEpoch: Number(row.lane_epoch), workflowEpoch: Number(row.workflow_epoch),
    },
    issuedAt: toIso(row.issued_at), expiresAt: toIso(row.expires_at),
    status: String(row.status) as IntegrationPushCapabilityRecord['status'],
    ...(row.consumed_at ? { consumedAt: toIso(row.consumed_at) } : {}),
    ...(row.revoked_at ? { revokedAt: toIso(row.revoked_at) } : {}),
    ...(row.revoke_reason ? { revokeReason: String(row.revoke_reason) } : {}),
  };
}

function sameBinding(a: IntegrationPushCapabilityBinding, b: IntegrationPushCapabilityBinding): boolean {
  return a.tenantId === b.tenantId && a.repositoryId === b.repositoryId
    && a.integrationTaskId === b.integrationTaskId && a.candidateId === b.candidateId
    && a.revision === b.revision && a.executionId === b.executionId && a.exactRef === b.exactRef
    && a.expectedOldOid === b.expectedOldOid && a.expectedBaseOid === b.expectedBaseOid
    && a.laneEpoch === b.laneEpoch && a.workflowEpoch === b.workflowEpoch;
}

function matchesFenceRow(binding: IntegrationPushCapabilityBinding, row: Record<string, unknown>): boolean {
  return row.enabled === true && String(row.candidate_id) === binding.candidateId
    && Number(row.revision) === binding.revision && Number(row.lane_epoch) === binding.laneEpoch
    && Number(row.workflow_epoch) === binding.workflowEpoch;
}

function fenceMovesBackwards(next: IntegrationPushFence, current: Record<string, unknown>): boolean {
  const lane = Number(current.lane_epoch);
  const workflow = Number(current.workflow_epoch);
  return next.laneEpoch < lane || next.workflowEpoch < workflow
    || (next.enabled && current.enabled === false && next.laneEpoch === lane && next.workflowEpoch === workflow);
}

function toIso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
