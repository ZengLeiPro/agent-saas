import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { normalizeRunRecord } from './runStoreRecordHelpers.js';
import { RunCreateConflictError } from './runStoreTypes.js';
import type {
  PgPool,
  RunRecord,
  SubagentContinuationReservation,
  UpsertRunInput,
} from './runStoreTypes.js';

export async function listSubagentRunsByAgentId(
  pool: PgPool,
  runsTable: string,
  tenantId: string,
  parentSessionId: string,
  agentId: string,
  options: { userId?: string; limit?: number } = {},
): Promise<RunRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const result = await pool.query<{ row_json: RunRecord }>(
    `
    SELECT row_to_json(run.*) AS row_json
    FROM ${runsTable} run
    WHERE run.tenant_id = $1
      AND run.metadata->>'parentSessionId' = $2
      AND run.metadata->>'subagentAgentId' = $3
      AND run.metadata->>'subagent' = 'true'
      AND ($4::text IS NULL OR run.user_id = $4 OR run.submitter_scope = $4)
    ORDER BY run.requested_at DESC, run.run_id DESC
    LIMIT $5
  `,
    [tenantId, parentSessionId, agentId, options.userId ?? null, limit],
  );
  return result.rows.map((row) => normalizeRunRecord(row.row_json));
}

/**
 * 在数据库事务内串行化同一个 logical agent 的 idle continuation。
 * reservation 本身就是待启动的 child run，后续 runner 只补齐 metadata，
 * 因而另一实例要么将新消息 steering 到它，要么看到明确的非终态冲突。
 */
export async function reserveSubagentContinuation(
  pool: PgPool,
  runsTable: string,
  input: UpsertRunInput & { agentId: string; parentSessionId: string },
): Promise<SubagentContinuationReservation> {
  const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${runsTable}:subagent-continuation:${tenantId}:${input.parentSessionId}:${input.agentId}`,
    ]);
    const active = await client.query<{ row_json: RunRecord }>(
      `
      SELECT row_to_json(run.*) AS row_json
      FROM ${runsTable} run
      WHERE run.tenant_id = $1
        AND run.metadata->>'parentSessionId' = $2
        AND run.metadata->>'subagentAgentId' = $3
        AND run.metadata->>'subagent' = 'true'
        AND COALESCE(run.metadata->>'backgroundTask', 'false') <> 'true'
        AND COALESCE(run.metadata->>'subagentResumeMessage', 'false') <> 'true'
        AND run.status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
      ORDER BY run.requested_at DESC, run.run_id DESC
      LIMIT 1
    `,
      [tenantId, input.parentSessionId, input.agentId],
    );
    if (active.rows[0]) {
      await client.query('COMMIT');
      return { state: 'active', record: normalizeRunRecord(active.rows[0].row_json) };
    }
    const now = new Date().toISOString();
    const inserted = await client.query<{ row_json: RunRecord }>(
      `
      INSERT INTO ${runsTable}
        (run_id, session_id, user_id, tenant_id, status, model, channel, requested_at, updated_at,
         idempotency_key, execution_target, workspace_id, sandbox_scope_id, submitter_scope, metadata,
         liveness_state, liveness_detected_at, liveness_version)
      VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$7,$8,$9,$10,$11,$12,$13::jsonb,
         'active',$7,1)
      ON CONFLICT (run_id) DO NOTHING
      RETURNING row_to_json(${runsTable}.*) AS row_json
    `,
      [
        input.runId,
        input.sessionId,
        input.userId ?? null,
        tenantId,
        input.model ?? null,
        input.channel ?? null,
        now,
        input.idempotencyKey ?? input.runId,
        input.executionTarget ?? null,
        input.workspaceId ?? null,
        input.sandboxScopeId ?? null,
        input.submitterUserId ?? input.userId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    if (!inserted.rows[0]) {
      throw new RunCreateConflictError(
        `Subagent continuation reservation conflict: ${input.runId}`,
      );
    }
    await client.query('COMMIT');
    return { state: 'reserved', record: normalizeRunRecord(inserted.rows[0].row_json) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
