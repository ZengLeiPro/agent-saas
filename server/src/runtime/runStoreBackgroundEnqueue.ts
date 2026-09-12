import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { normalizeRunRecord, parseCount, stringMetadata } from './runStoreRecordHelpers.js';
import { BackgroundTaskLimitError } from './runStoreTypes.js';
import type {
  EnqueueBackgroundTaskLimits,
  PgPool,
  RunRecord,
  UpsertRunInput,
} from './runStoreTypes.js';

export async function enqueueBackgroundTask(
  pool: PgPool,
  runsTable: string,
  input: UpsertRunInput,
  limits: EnqueueBackgroundTaskLimits,
): Promise<RunRecord> {
  const parentRunId = stringMetadata(input.metadata, 'parentRunId');
  const parentSessionId = stringMetadata(input.metadata, 'parentSessionId');
  if (!parentRunId || !parentSessionId || input.metadata?.backgroundTask !== true) {
    throw new Error(
      'enqueueBackgroundTask requires backgroundTask/parentRunId/parentSessionId metadata',
    );
  }
  const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
  const agentId = stringMetadata(input.metadata, 'subagentAgentId');
  const continuation = input.metadata?.subagentContinuation;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `${runsTable}:background-task-quota`,
    ]);
    if (agentId && continuation && typeof continuation === 'object') {
      const active = await client.query<{ run_id: string }>(
        `
        SELECT run_id FROM ${runsTable}
        WHERE tenant_id = $1
          AND metadata->>'parentSessionId' = $2
          AND metadata->>'subagentAgentId' = $3
          AND metadata->>'subagent' = 'true'
          AND COALESCE(metadata->>'subagentResumeMessage', 'false') <> 'true'
          AND status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
        LIMIT 1
      `,
        [tenantId, parentSessionId, agentId],
      );
      if (active.rows[0]) {
        throw new Error(`SUBAGENT_CONTINUATION_ACTIVE:${agentId}:${active.rows[0].run_id}`);
      }
    }
    const counts = await client.query<{
      parent_active: string | number;
      tenant_active: string | number;
    }>(
      `
      SELECT
        COUNT(*) FILTER (
          WHERE metadata->>'parentRunId' = $1
            AND status IN ('pending','running')
        ) AS parent_active,
        COUNT(*) FILTER (
          WHERE tenant_id = $2
            AND status IN ('pending','running')
        ) AS tenant_active
      FROM ${runsTable}
      WHERE metadata->>'backgroundTask' = 'true'
    `,
      [parentRunId, tenantId],
    );
    const parentActive = parseCount(counts.rows[0]?.parent_active);
    const tenantActive = parseCount(counts.rows[0]?.tenant_active);
    if (parentActive >= limits.perParentActive) {
      throw new BackgroundTaskLimitError(
        `本次运行同时活跃的后台任务已达上限 ${limits.perParentActive}`,
      );
    }
    if (tenantActive >= limits.perTenantActive) {
      throw new BackgroundTaskLimitError(
        `当前组织同时活跃的后台任务已达上限 ${limits.perTenantActive}`,
      );
    }
    const now = new Date().toISOString();
    const result = await client.query<{ row_json: RunRecord }>(
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
        input.idempotencyKey ?? null,
        input.executionTarget ?? null,
        input.workspaceId ?? null,
        input.sandboxScopeId ?? null,
        input.submitterUserId ?? input.userId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    if (!result.rows[0]) throw new Error(`background task run already exists: ${input.runId}`);
    await client.query('COMMIT');
    return normalizeRunRecord(result.rows[0].row_json);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
