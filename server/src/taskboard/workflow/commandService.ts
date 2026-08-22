import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type {
  TaskBoardTask,
} from '../../../../shared/src/types/taskboard.js';
import { TaskboardValidationError } from '../types.js';

export interface WorkflowCommandHost {
  tasksTable: string;
  executionsTable: string;
  changesTable: string;
  integrationSourcesTable: string;
  remediationAttemptsTable: string;
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

export interface MergedRemediationCompletionInput {
  remediationTaskId: string;
  sourceId: string;
  commandId: string;
  attemptId?: string;
  mergedCommitOid?: string;
}

/**
 * System-owned workflow command for the merge-first path. A provider merge is
 * authoritative for its linked remediation, so the remediation is completed
 * through the same task projection fields as the normal workflow transition instead of
 * being repaired by an ad-hoc terminal-state update.
 */
export async function completeRemediationAfterMerge(
  host: Pick<WorkflowCommandHost, 'tasksTable' | 'changesTable' | 'remediationAttemptsTable'>,
  client: PoolClient,
  input: MergedRemediationCompletionInput,
): Promise<boolean> {
  const taskResult = await client.query(
    `SELECT id,kind,status,completed_at
       FROM ${host.tasksTable}
      WHERE id=$1
      FOR UPDATE`,
    [input.remediationTaskId],
  );
  const task = taskResult.rows[0];
  if (!task) return false;
  if (task.kind !== 'remediation') {
    throw new TaskboardValidationError(
      'Merge completion can only converge remediation tasks',
      'TASKBOARD_REMEDIATION_KIND_INVALID',
    );
  }

  const attempts = await client.query(
    `SELECT id,state
       FROM ${host.remediationAttemptsTable}
      WHERE integration_source_id=$1 AND remediation_task_id=$2
        AND state IN ('active','resolved')
        AND ($3::text IS NULL OR id=$3)
      ORDER BY round DESC, id DESC
      FOR UPDATE`,
    [input.sourceId, input.remediationTaskId, input.attemptId ?? null],
  );
  if (input.attemptId && !attempts.rows[0]) return false;

  let changed = false;
  if (task.status !== 'canceled') {
    const updatedTask = await client.query(
      `UPDATE ${host.tasksTable}
          SET status='done',completed_at=COALESCE(completed_at,now()),
              workflow_epoch=workflow_epoch+CASE WHEN status='done' THEN 0 ELSE 1 END,
              next_action='none',
              next_action_revision=next_action_revision+CASE WHEN status='done' THEN 0 ELSE 1 END,
              version=version+CASE WHEN status='done' THEN 0 ELSE 1 END,
              updated_at=now()
        WHERE id=$1 AND status<>'canceled'
          AND (status<>'done' OR completed_at IS NULL)
        RETURNING id`,
      [input.remediationTaskId],
    );
    changed = updatedTask.rows.length > 0;
  }

  for (const attempt of attempts.rows) {
    const updatedAttempt = await client.query(
      `UPDATE ${host.remediationAttemptsTable}
          SET state='resolved',resolved_at=COALESCE(resolved_at,now())
        WHERE id=$1 AND state IN ('active','resolved')
          AND (state<>'resolved' OR resolved_at IS NULL)
        RETURNING id`,
      [attempt.id],
    );
    changed = changed || updatedAttempt.rows.length > 0;
  }

  if (changed) {
    await client.query(
      `INSERT INTO ${host.changesTable}
         (task_id,change_type,actor_type,actor_id,payload)
       SELECT $1,'workflow.remediation_completed_after_merge','system',$2,$3::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM ${host.changesTable}
           WHERE task_id=$1 AND change_type='workflow.remediation_completed_after_merge'
             AND payload->>'commandId'=$2
        )`,
      [input.remediationTaskId, input.commandId, JSON.stringify({
        commandId: input.commandId,
        sourceId: input.sourceId,
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        ...(input.mergedCommitOid ? { mergedCommitOid: input.mergedCommitOid } : {}),
      })],
    );
  }
  return changed;
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
