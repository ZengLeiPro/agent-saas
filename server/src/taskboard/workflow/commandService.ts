import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type {
  TaskBoardExecution,
  TaskBoardExecutionResolutionInput,
  TaskBoardTask,
} from '../../../../shared/src/types/taskboard.js';
import { TaskboardValidationError } from '../types.js';

export interface WorkflowCommandHost {
  tasksTable: string;
  executionsTable: string;
  changesTable: string;
  integrationSourcesTable: string;
  remediationAttemptsTable: string;
  resolutionsTable: string;
  cancellationOutboxTable: string;
}

export async function loadWorkflowFacts(
  host: Pick<WorkflowCommandHost, 'integrationSourcesTable' | 'remediationAttemptsTable'>,
  client: PoolClient,
  task: Pick<TaskBoardTask, 'id' | 'mergedCommitOid'>,
): Promise<{ hasMergeFact: boolean }> {
  if (task.mergedCommitOid) return { hasMergeFact: true };
  const result = await client.query(
    `SELECT (
       EXISTS (
         SELECT 1 FROM ${host.integrationSourcesTable} s
          WHERE s.delivery_task_id=$1
            AND (s.state='merged' OR s.merged_commit_oid IS NOT NULL OR s.provider_receipt_id IS NOT NULL)
       ) OR EXISTS (
         SELECT 1 FROM ${host.integrationSourcesTable} s
          WHERE s.integration_task_id=$1
          GROUP BY s.integration_task_id
         HAVING bool_and(s.state='merged' OR s.merged_commit_oid IS NOT NULL OR s.provider_receipt_id IS NOT NULL)
       ) OR EXISTS (
         SELECT 1 FROM ${host.remediationAttemptsTable} a
         JOIN ${host.integrationSourcesTable} s ON s.id=a.integration_source_id
          WHERE a.remediation_task_id=$1
            AND (s.state='merged' OR s.merged_commit_oid IS NOT NULL OR s.provider_receipt_id IS NOT NULL)
       )
     ) AS merged`,
    [task.id],
  );
  return { hasMergeFact: result.rows[0]?.merged === true };
}

function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map((item) => normalize(item));
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]));
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

export async function insertResolution(
  host: WorkflowCommandHost,
  client: PoolClient,
  task: TaskBoardTask,
  execution: TaskBoardExecution,
  input: TaskBoardExecutionResolutionInput,
  decision: { applied: boolean; toStatus?: string; ignoredReason?: string },
): Promise<{ replay: boolean; resolutionId: string }> {
  const resolutionId = input.resolutionId?.trim() || randomUUID();
  // Objects are recursively key-sorted while arrays retain caller order (evidence order is semantic).
  const payloadDigest = createHash('sha256').update(canonicalJson({
    outcome: input.outcome,
    summary: input.summary,
    evidence: input.evidence ?? [],
    receipt: input.receipt,
  })).digest('hex');
  const existing = await client.query(
    `SELECT execution_id,resolution_id,payload_digest FROM ${host.resolutionsTable}
      WHERE execution_id=$1 OR resolution_id=$2
      ORDER BY CASE WHEN execution_id=$1 THEN 0 ELSE 1 END LIMIT 1`,
    [execution.id, resolutionId],
  );
  if (existing.rows[0]) {
    const sameExecution = String(existing.rows[0].execution_id) === execution.id;
    const sameRequestedId = !input.resolutionId
      || String(existing.rows[0].resolution_id) === input.resolutionId.trim();
    if (!sameExecution || !sameRequestedId || String(existing.rows[0].payload_digest) !== payloadDigest) {
      throw new TaskboardValidationError(
        'Execution already has a different canonical resolution',
        'TASKBOARD_RESOLUTION_CONFLICT',
      );
    }
    return { replay: true, resolutionId: String(existing.rows[0].resolution_id) };
  }
  const inserted = await client.query(
    `INSERT INTO ${host.resolutionsTable}
       (execution_id,attempt_id,resolution_id,payload_digest,outcome,summary,evidence,receipt,
        from_status,to_status,from_version,to_version,applied,ignored_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14)
     ON CONFLICT DO NOTHING RETURNING resolution_id`,
    [
      execution.id, execution.attemptId ?? execution.id, resolutionId, payloadDigest,
      input.outcome, input.summary, JSON.stringify(input.evidence ?? []), JSON.stringify(input.receipt),
      task.status, decision.toStatus ?? null, task.version,
      decision.applied && decision.toStatus ? task.version + 1 : null,
      decision.applied, decision.ignoredReason ?? null,
    ],
  );
  if (!inserted.rows[0]) {
    const concurrent = await client.query(
      `SELECT execution_id,resolution_id,payload_digest FROM ${host.resolutionsTable}
        WHERE execution_id=$1 OR resolution_id=$2
        ORDER BY CASE WHEN execution_id=$1 THEN 0 ELSE 1 END LIMIT 1`,
      [execution.id, resolutionId],
    );
    const row = concurrent.rows[0];
    const sameExecution = row && String(row.execution_id) === execution.id;
    const sameRequestedId = row && (!input.resolutionId || String(row.resolution_id) === input.resolutionId.trim());
    if (!sameExecution || !sameRequestedId || String(row.payload_digest) !== payloadDigest) {
      throw new TaskboardValidationError(
        'Execution already has a different canonical resolution',
        'TASKBOARD_RESOLUTION_CONFLICT',
      );
    }
    return { replay: true, resolutionId: String(row.resolution_id) };
  }
  await client.query(
    `UPDATE ${host.executionsTable}
        SET resolution_id=$2,resolved_at=now(),fence_epoch=fence_epoch+1,updated_at=now()
      WHERE id=$1`,
    [execution.id, resolutionId],
  );
  return { replay: false, resolutionId };
}

export async function fenceTaskExecutions(
  host: WorkflowCommandHost,
  client: PoolClient,
  taskIds: string[],
  reason: string,
  exceptExecutionId?: string,
): Promise<number> {
  const uniqueIds = [...new Set(taskIds)].sort();
  if (!uniqueIds.length) return 0;
  const result = await client.query(
    `UPDATE ${host.executionsTable}
        SET status='cancelled',finished_at=COALESCE(finished_at,now()),
            superseded_at=COALESCE(superseded_at,now()),fence_epoch=fence_epoch+1,
            terminal_reason_code=$3,error=COALESCE(error,$3),updated_at=now()
      WHERE task_id=ANY($1::text[])
        AND ($2::text IS NULL OR id<>$2)
        AND status IN ('queued','running','waiting_user','waiting_approval')
        AND superseded_at IS NULL
      RETURNING id,run_id,fence_epoch,task_id`,
    [uniqueIds, exceptExecutionId ?? null, reason],
  );
  for (const row of result.rows) {
    await client.query(
      `INSERT INTO ${host.cancellationOutboxTable}
         (id,execution_id,run_id,task_id,reason,fence_epoch)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (execution_id) DO NOTHING`,
      [randomUUID(), row.id, row.run_id, row.task_id, reason, row.fence_epoch],
    );
    await client.query(
      `INSERT INTO ${host.changesTable}
         (task_id,change_type,actor_type,actor_id,execution_id,payload)
       VALUES ($1,'execution.superseded','system',$2,$3,$4::jsonb)`,
      [row.task_id, reason, row.id, JSON.stringify({ runId: row.run_id, reason, fenceEpoch: String(row.fence_epoch) })],
    );
  }
  return result.rowCount ?? result.rows.length;
}

export function assertReceiptIdentityBoundToExecution(
  execution: TaskBoardExecution,
  input: TaskBoardExecutionResolutionInput,
): void {
  const receipt = input.receipt;
  if (
    receipt.schemaVersion !== 2
    || receipt.runId !== execution.runId
    || receipt.executionId !== execution.id
    || receipt.attemptId !== (execution.attemptId ?? execution.id)
    || receipt.purpose !== execution.purpose
    || !/^\d+$/.test(receipt.workflowEpoch ?? '')
    || !/^\d+$/.test(receipt.fenceEpoch ?? '')
    || BigInt(receipt.fenceEpoch ?? '0') > BigInt(execution.fenceEpoch ?? '0')
  ) {
    throw new TaskboardValidationError(
      'Context receipt is not bound to the current execution attempt',
      'TASKBOARD_CONTEXT_EXECUTION_MISMATCH',
    );
  }
}

export function assertReceiptBoundToExecution(
  execution: TaskBoardExecution,
  input: TaskBoardExecutionResolutionInput,
  workflowEpoch: string,
): void {
  assertReceiptIdentityBoundToExecution(execution, input);
  const receipt = input.receipt;
  if (
    receipt.workflowEpoch !== workflowEpoch
    || receipt.fenceEpoch !== (execution.fenceEpoch ?? '0')
  ) {
    throw new TaskboardValidationError(
      'Context receipt is not bound to the current execution attempt',
      'TASKBOARD_CONTEXT_EXECUTION_MISMATCH',
    );
  }
}
