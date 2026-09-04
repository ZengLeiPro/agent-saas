import type pg from 'pg';

import type { OrgAgentResultEnvelope, OrgAgentWorkAttempt } from './types.js';
import { mapWorkAttempt } from './storeMappers.js';

export async function transitionWorkAttempt(
  pool: pg.Pool,
  attemptsTable: string,
  workOrdersTable: string,
  input: {
    tenantId: string;
    runtimeRunId: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    resultEnvelope?: OrgAgentResultEnvelope;
    failure?: string;
    checkpoint?: Record<string, unknown>;
    artifactManifest?: Record<string, unknown>;
    publishState?: OrgAgentWorkAttempt['publishState'];
  },
): Promise<OrgAgentWorkAttempt | null> {
  if (input.status === 'running') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT attempt.*,work.state AS work_state,work.current_attempt_no
        FROM ${attemptsTable} attempt
        JOIN ${workOrdersTable} work
          ON work.tenant_id=attempt.tenant_id AND work.work_order_id=attempt.work_order_id
        WHERE attempt.tenant_id=$1 AND attempt.runtime_run_id=$2
        FOR UPDATE OF attempt,work`,
        [input.tenantId, input.runtimeRunId],
      );
      const row = selected.rows[0] as Record<string, unknown> | undefined;
      if (
        !row ||
        row.status !== 'queued' ||
        Number(row.attempt_no) !== Number(row.current_attempt_no) ||
        !['queued', 'running'].includes(String(row.work_state))
      ) {
        await client.query('ROLLBACK');
        return null;
      }
      const result = await client.query(
        `UPDATE ${attemptsTable}
        SET status='running',started_at=COALESCE(started_at,NOW()),updated_at=NOW()
        WHERE tenant_id=$1 AND runtime_run_id=$2 AND status='queued' RETURNING *`,
        [input.tenantId, input.runtimeRunId],
      );
      if (!result.rows[0]) throw new Error('ORG_AGENT_WORK_ATTEMPT_START_CONFLICT');
      if (row.work_state === 'queued') {
        await client.query(
          `UPDATE ${workOrdersTable}
          SET state='running',version=version+1,updated_at=NOW()
          WHERE tenant_id=$1 AND work_order_id=$2 AND state='queued' AND current_attempt_no=$3`,
          [input.tenantId, row.work_order_id, row.attempt_no],
        );
      }
      await client.query('COMMIT');
      return mapWorkAttempt(result.rows[0] as Record<string, unknown>);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  const terminal = true;
  const result = await pool.query(
    `UPDATE ${attemptsTable}
    SET status=$3,result_envelope_json=COALESCE($4::jsonb,result_envelope_json),failure=$5,
        checkpoint_json=COALESCE($6::jsonb,checkpoint_json),
        artifact_manifest_json=COALESCE($7::jsonb,artifact_manifest_json),
        publish_state=COALESCE($8,publish_state),
        started_at=CASE WHEN $3='running' THEN COALESCE(started_at,NOW()) ELSE started_at END,
        completed_at=CASE WHEN $9 THEN NOW() ELSE completed_at END,updated_at=NOW()
    WHERE tenant_id=$1 AND runtime_run_id=$2
      AND status NOT IN ('completed','failed','cancelled') RETURNING *`,
    [
      input.tenantId,
      input.runtimeRunId,
      input.status,
      input.resultEnvelope ? JSON.stringify(input.resultEnvelope) : null,
      input.failure ?? null,
      input.checkpoint ? JSON.stringify(input.checkpoint) : null,
      input.artifactManifest ? JSON.stringify(input.artifactManifest) : null,
      input.publishState ?? null,
      terminal,
    ],
  );
  return result.rows[0] ? mapWorkAttempt(result.rows[0] as Record<string, unknown>) : null;
}

export async function transitionWorkAttemptPublishState(
  pool: pg.Pool,
  table: string,
  input: {
    tenantId: string;
    attemptId: string;
    expectedState: 'pending';
    state: 'published' | 'conflict' | 'rejected';
    artifactManifest?: Record<string, unknown>;
  },
): Promise<OrgAgentWorkAttempt> {
  const result = await pool.query(
    `UPDATE ${table}
    SET publish_state=$4,
        artifact_manifest_json=COALESCE($5::jsonb,artifact_manifest_json),updated_at=NOW()
    WHERE tenant_id=$1 AND attempt_id=$2 AND publish_state=$3
      AND status IN ('completed','failed','cancelled') RETURNING *`,
    [
      input.tenantId,
      input.attemptId,
      input.expectedState,
      input.state,
      input.artifactManifest ? JSON.stringify(input.artifactManifest) : null,
    ],
  );
  if (!result.rows[0]) throw new Error('ORG_AGENT_ARTIFACT_PUBLISH_STATE_CONFLICT');
  return mapWorkAttempt(result.rows[0] as Record<string, unknown>);
}
