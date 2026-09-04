import type pg from 'pg';

export type InterruptedAutomationBackgroundRecovery =
  | 'requeued'
  | 'reconcile_required'
  | 'terminal_preserved';

interface RecoveryLineage {
  tenantId: string;
  sessionId: string;
  automationId: string;
  incarnationId: string;
  generation: number;
  specVersion: number;
  executionId: string;
  invokingSessionId: string;
  invokingRunId: string;
  executionRunId: string;
}

interface RecoveryTables {
  automations: string;
  backgroundResources: string;
  providerAttempts: string;
  interactions: string;
}

interface LockedRun {
  run_id: string;
  session_id: string;
  status: string;
  metadata: Record<string, unknown>;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function matchesFence(
  metadata: Record<string, unknown>,
  lineage: RecoveryLineage,
  runId: string,
): boolean {
  const fence = metadataRecord(metadata.automationFence);
  return fence.automationId === lineage.automationId
    && fence.incarnationId === lineage.incarnationId
    && fence.generation === lineage.generation
    && fence.specVersion === lineage.specVersion
    && fence.executionId === lineage.executionId
    && fence.runId === runId
    && fence.rootSessionId === lineage.sessionId
    && fence.rootRunId === lineage.executionRunId;
}

async function markReconcileRequired(
  client: pg.PoolClient,
  tables: RecoveryTables,
  lineage: RecoveryLineage,
): Promise<void> {
  await client.query(
    `UPDATE ${tables.automations}
        SET status='reconcile_required',phase='waiting',next_wakeup_at=NULL,
            projection_version=projection_version+1,updated_at=now()
      WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
        AND incarnation_id=$4 AND generation=$5 AND spec_version=$6
        AND status='active'`,
    [lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.incarnationId,
      lineage.generation, lineage.specVersion],
  );
}

/**
 * Recovers only a background child whose durable resource intent never crossed a side-effect boundary.
 * Resource plus available run rows are locked before the evidence check and status transition.
 */
export async function recoverInterruptedAutomationBackground(
  pool: pg.Pool,
  runsTable: string,
  tablePrefix: string,
  tables: RecoveryTables,
  lineage: RecoveryLineage,
  resourceKey: string,
  identity: { childSessionId: string; childRunId: string },
): Promise<InterruptedAutomationBackgroundRecovery> {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const resourceResult = await client.query<{ state: string }>(
      `SELECT state FROM ${tables.backgroundResources}
        WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
          AND incarnation_id=$4 AND generation=$5 AND execution_id=$6 AND run_id=$7
          AND resource_kind='child_run' AND resource_key=$8 AND provider_resource_id=$9
          AND metadata->>'childSessionId'=$10
          AND metadata->>'childRunId'=$9
          AND metadata->>'invokingSessionId'=$11
          AND metadata->>'invokingRunId'=$12
          AND metadata->>'rootSessionId'=$2
          AND metadata->>'rootRunId'=$7
        FOR UPDATE`,
      [lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.incarnationId,
        lineage.generation, lineage.executionId, lineage.executionRunId, resourceKey,
        identity.childRunId, identity.childSessionId, lineage.invokingSessionId, lineage.invokingRunId],
    );
    const runResult = await client.query<LockedRun>(
      `SELECT run_id,session_id,status,metadata FROM ${runsTable}
        WHERE tenant_id=$1 AND run_id=ANY($2::text[]) ORDER BY run_id FOR UPDATE`,
      [lineage.tenantId, [lineage.invokingRunId, identity.childRunId]],
    );
    const parent = runResult.rows.find(row => row.run_id === lineage.invokingRunId);
    const child = runResult.rows.find(row => row.run_id === identity.childRunId);
    if (!parent || parent.session_id !== lineage.invokingSessionId
      || !matchesFence(parent.metadata, lineage, lineage.invokingRunId)) {
      await markReconcileRequired(client, tables, lineage);
      await client.query('COMMIT'); committed = true;
      return 'reconcile_required';
    }
    if (parent.status !== 'running') {
      await client.query('COMMIT'); committed = true;
      return 'terminal_preserved';
    }
    const childIdentityMatches = !child || (
      child.session_id === identity.childSessionId
      && metadataRecord(child.metadata).parentRunId === lineage.invokingRunId
      && metadataRecord(child.metadata).parentSessionId === lineage.invokingSessionId
      && matchesFence(child.metadata, lineage, identity.childRunId)
    );
    const resourceState = resourceResult.rows[0]?.state;
    if (!childIdentityMatches || (child && !['running', 'pending'].includes(child.status))
      || resourceState !== 'prepared') {
      await markReconcileRequired(client, tables, lineage);
      await client.query('COMMIT'); committed = true;
      return child?.status === 'cancelled' ? 'terminal_preserved' : 'reconcile_required';
    }
    const providerSideEffect = await client.query(
      `SELECT 1 FROM ${tables.providerAttempts}
        WHERE tenant_id=$1 AND automation_id=$2 AND incarnation_id=$3 AND generation=$4
          AND execution_id=$5 AND run_id=$6
          AND invoking_run_id=ANY($7::text[])
          AND state IN ('dispatched','completed','result_unknown','reconcile') LIMIT 1 FOR UPDATE`,
      [lineage.tenantId, lineage.automationId, lineage.incarnationId, lineage.generation,
        lineage.executionId, lineage.executionRunId, [lineage.invokingRunId, identity.childRunId]],
    );
    const interactionSideEffect = await client.query(
      `SELECT 1 FROM ${tables.interactions}
        WHERE tenant_id=$1 AND automation_id=$2 AND incarnation_id=$3 AND generation=$4
          AND execution_id=$5 AND run_id=$6
          AND state IN ('active','completed','result_unknown','reconcile') LIMIT 1 FOR UPDATE`,
      [lineage.tenantId, lineage.automationId, lineage.incarnationId, lineage.generation,
        lineage.executionId, lineage.executionRunId],
    );
    const toolSideEffect = await client.query(
      `SELECT 1 FROM ${tablePrefix}_tool_invocations
        WHERE tenant_id=$1 AND run_id=ANY($2::text[]) LIMIT 1 FOR UPDATE`,
      [lineage.tenantId, [lineage.invokingRunId, identity.childRunId]],
    );
    if (providerSideEffect.rowCount || interactionSideEffect.rowCount || toolSideEffect.rowCount) {
      await markReconcileRequired(client, tables, lineage);
      await client.query('COMMIT'); committed = true;
      return 'reconcile_required';
    }
    const updated = await client.query(
      `UPDATE ${runsTable} AS target
          SET status='pending',status_reason='background_task_interrupted_replay_ready',
              worker_id=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE target.tenant_id=$1
          AND EXISTS (
            SELECT 1 FROM ${runsTable} AS parent
             WHERE parent.tenant_id=$1 AND parent.run_id=$2 AND parent.status='running'
          )
          AND (
            (target.run_id=$2 AND target.status='running')
            OR (target.run_id=$3 AND target.status IN ('pending','running'))
          )`,
      [lineage.tenantId, lineage.invokingRunId, identity.childRunId],
    );
    if (updated.rowCount !== (child ? 2 : 1)) throw new Error('interrupted background run lock lost');
    await client.query('COMMIT'); committed = true;
    return 'requeued';
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
