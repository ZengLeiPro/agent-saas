import type { PoolClient } from 'pg';

import type { TaskBoardIntegrationSource } from '../../../shared/src/types/taskboard.js';
import { integrationAgentTableNames } from './integrationAgentSchema.js';
import { rowToIntegrationSource } from './integrationSourceMapper.js';
import type { IntegrationFinalizationHost } from './integrationFinalizationHost.js';
import { rowToTask, visibleCommentPredicate } from './storeHelpers.js';
import { TaskboardNotFoundError, TaskboardValidationError } from './types.js';
import {
  completeRemediationAfterMerge,
  fenceTaskExecutions,
} from './workflow/commandService.js';
import { recordExecutionFinishComment } from './workflow/finishComment.js';

export async function finalizeMergedSource(
  host: IntegrationFinalizationHost,
  sourceId: string,
  input: {
    providerRequestId: string;
    mergedCommitOid: string;
    raw: Record<string, unknown>;
    operationId?: string;
    reconciled?: boolean;
    exceptExecutionId?: string;
    expectedReview?: {
      deliveryTaskId: string;
      providerPullRequestId: string;
      executionId: string;
    };
    finishComment?: { taskId: string; runId: string; body: string };
  },
): Promise<{ source: TaskBoardIntegrationSource; task: ReturnType<typeof rowToTask>; receipt: Record<string, unknown> }> {
  return withIntegrationTransaction(host, async (client) => {
    // Discover aggregate members without locks, then acquire the global Task -> Source -> Execution order.
    const preview = await client.query(
      `SELECT delivery_task_id,integration_task_id,remediation_task_id
         FROM ${host.integrationSourcesTable}
        WHERE id=$1`,
      [sourceId],
    );
    if (!preview.rows[0]) throw new TaskboardNotFoundError('Integration source not found');
    const remediationRows = await client.query(
      `SELECT DISTINCT remediation_task_id
         FROM ${host.remediationAttemptsTable}
        WHERE integration_source_id=$1 AND state IN ('active','resolved')`,
      [sourceId],
    );
    const remediationTaskIds = [...new Set([
      ...(preview.rows[0].remediation_task_id ? [String(preview.rows[0].remediation_task_id)] : []),
      ...remediationRows.rows.map((row) => String(row.remediation_task_id)),
    ])];
    const aggregateTaskIds = [...new Set([
      String(preview.rows[0].delivery_task_id),
      String(preview.rows[0].integration_task_id),
      ...remediationTaskIds,
    ])].sort();
    await client.query(
      `SELECT id FROM ${host.tasksTable} WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`,
      [aggregateTaskIds],
    );
    const sourceResult = await client.query(
      `SELECT * FROM ${host.integrationSourcesTable} WHERE id=$1 FOR UPDATE`,
      [sourceId],
    );
    const sourceRow = sourceResult.rows[0];
    if (!sourceRow) throw new TaskboardNotFoundError('Integration source not found');
    if (input.expectedReview) {
      if (String(sourceRow.delivery_task_id) !== input.expectedReview.deliveryTaskId
        || String(sourceRow.provider_pull_request_id) !== input.expectedReview.providerPullRequestId) {
        throw new TaskboardValidationError(
          'Pull request changed during merge reconciliation',
          'TASKBOARD_SUBJECT_STALE',
        );
      }
      const delivery = await client.query(
        `SELECT provider_pull_request_id FROM ${host.tasksTable} WHERE id=$1`,
        [input.expectedReview.deliveryTaskId],
      );
      if (String(delivery.rows[0]?.provider_pull_request_id ?? '') !== input.expectedReview.providerPullRequestId) {
        throw new TaskboardValidationError(
          'Pull request changed during merge reconciliation',
          'TASKBOARD_SUBJECT_STALE',
        );
      }
      const execution = await client.query(
        `SELECT id FROM ${host.executionsTable}
          WHERE id=$1 AND task_id=$2
            AND status IN ('queued','running','waiting_user','waiting_approval')
            AND transitioned_at IS NULL AND superseded_at IS NULL
          FOR UPDATE`,
        [input.expectedReview.executionId, input.expectedReview.deliveryTaskId],
      );
      if (!execution.rows[0]) {
        throw new TaskboardValidationError('Taskboard execution changed');
      }
    }
    if (input.finishComment) {
      await recordExecutionFinishComment(host, client, input.finishComment, input.finishComment.body);
    }
    const alreadyMerged = sourceRow.state === 'merged';
    if (alreadyMerged && String(sourceRow.merged_commit_oid ?? '') !== input.mergedCommitOid) {
      throw new TaskboardValidationError(
        'Merge receipt conflicts with the canonical merged commit',
        'TASKBOARD_MERGE_RECEIPT_CONFLICT',
      );
    }

    if (!alreadyMerged) {
      await client.query(
        `UPDATE ${host.integrationSourcesTable}
            SET state='merged', provider_receipt_id=$2, merged_commit_oid=$3,
                last_error=NULL, updated_at=now()
          WHERE id=$1`,
        [sourceId, input.providerRequestId, input.mergedCommitOid],
      );
    }
    if (input.operationId) {
      await client.query(
        `UPDATE ${host.mergeOperationsTable}
            SET state=$5, provider_request_id=$2, provider_receipt=$3::jsonb,
                merged_commit_oid=$4, error=NULL, updated_at=now()
          WHERE id=$1 AND state IN ('prepared','executing','unknown')`,
        [input.operationId, input.providerRequestId, JSON.stringify(input.raw), input.mergedCommitOid,
          input.reconciled ? 'reconciled' : 'succeeded'],
      );
    } else {
      await client.query(
        `UPDATE ${host.mergeOperationsTable}
            SET state='reconciled', provider_request_id=$2, provider_receipt=$3::jsonb,
                merged_commit_oid=$4, error=NULL, updated_at=now()
          WHERE integration_source_id=$1`,
        [sourceId, input.providerRequestId, JSON.stringify(input.raw), input.mergedCommitOid],
      );
    }

    await client.query(
      `UPDATE ${host.tasksTable}
          SET status='done', merged_commit_oid=$2, completed_at=COALESCE(completed_at,now()),
              workflow_epoch=workflow_epoch+1,next_action='none',next_action_revision=next_action_revision+1,
              version=version+1, updated_at=now()
        WHERE id=$1 AND (status<>'done' OR merged_commit_oid IS DISTINCT FROM $2)`,
      [sourceRow.delivery_task_id, input.mergedCommitOid],
    );
    for (const remediationTaskId of remediationTaskIds) {
      await completeRemediationAfterMerge(host, client, {
        remediationTaskId,
        sourceId,
        commandId: `merge:${sourceId}:${remediationTaskId}:${input.mergedCommitOid}`,
        mergedCommitOid: input.mergedCommitOid,
      });
    }
    await client.query(
      `UPDATE ${host.blockEpisodesTable} SET closed_at=COALESCE(closed_at,now())
        WHERE task_id=ANY($1::text[]) AND closed_at IS NULL`,
      [aggregateTaskIds],
    );
    await fenceTaskExecutions(
      host,
      client,
      aggregateTaskIds.filter((id) => id !== String(sourceRow.integration_task_id)),
      'merge_confirmed',
    );

    const remaining = await client.query(
      `SELECT 1 FROM ${host.integrationSourcesTable}
        WHERE integration_task_id=$1 AND state<>'merged' LIMIT 1`,
      [sourceRow.integration_task_id],
    );
    if (!remaining.rows[0]) {
      await client.query(
        `UPDATE ${host.tasksTable}
            SET status='done',completed_at=COALESCE(completed_at,now()),workflow_epoch=workflow_epoch+1,
                next_action='none',next_action_revision=next_action_revision+1,version=version+1,updated_at=now()
          WHERE id=$1 AND status<>'done'`,
        [sourceRow.integration_task_id],
      );
      await client.query(
        `UPDATE ${host.mergeAuthorizationsTable} SET revoked_at=COALESCE(revoked_at,now())
          WHERE integration_task_id=$1 AND revoked_at IS NULL`,
        [sourceRow.integration_task_id],
      );
      await client.query(
        `UPDATE ${host.integrationLanesTable}
            SET active_integration_task_id=NULL,lease_id=NULL,updated_at=now()
          WHERE repository_id=$1 AND active_integration_task_id=$2`,
        [sourceRow.repository_id, sourceRow.integration_task_id],
      );
      await fenceTaskExecutions(
        host,
        client,
        [String(sourceRow.integration_task_id)],
        'integration_converged',
        input.exceptExecutionId,
      );
    }

    if (!alreadyMerged) {
      await client.query(
        `INSERT INTO ${host.changesTable}
           (task_id, change_type, actor_type, actor_id, payload)
         VALUES ($1,'merge.succeeded.v2','system',$2,$3::jsonb)`,
        [sourceRow.delivery_task_id, input.providerRequestId, JSON.stringify({
          schemaVersion: 2,
          commandId: input.providerRequestId,
          integrationTaskId: sourceRow.integration_task_id,
          sourceId,
          mergedCommitOid: input.mergedCommitOid,
          providerRequestId: input.providerRequestId,
        })],
      );
    }
    const taskResult = await client.query(
      `SELECT t.*,
              (SELECT count(*)::int FROM ${host.commentsTable} c WHERE c.task_id=t.id AND ${visibleCommentPredicate('c', host.changesTable)}) AS comment_count
         FROM ${host.tasksTable} t WHERE t.id=$1`,
      [sourceRow.delivery_task_id],
    );
    const updatedSource = await client.query(`SELECT * FROM ${host.integrationSourcesTable} WHERE id=$1`, [sourceId]);
    return {
      source: rowToIntegrationSource(updatedSource.rows[0]!),
      task: rowToTask(taskResult.rows[0]!),
      receipt: input.raw,
    };
  });
}

/**
 * The Integration Agent produces one provider receipt for its whole source set.
 * Keep every local projection behind that receipt in one transaction so a provider
 * timeout can be replayed without leaving partially-completed delivery tasks.
 */
export async function finalizeMergedIntegrationAgent(
  host: IntegrationFinalizationHost,
  integrationTaskId: string,
  input: {
    providerRequestId: string;
    mergedCommitOid: string;
    raw: Record<string, unknown>;
    exceptExecutionId: string;
    expectedAgent: { providerPullRequestId: string; integrationBranch: string };
    event: { runId: string; executionId: string; reviewHeadOid: string; reviewExecutionId: string };
  },
): Promise<ReturnType<typeof rowToTask>> {
  return withIntegrationTransaction(host, async (client) => {
    const { agentsTable } = integrationAgentTableNames(host.integrationSourcesTable);
    const preview = await client.query(
      `SELECT id,delivery_task_id,remediation_task_id
         FROM ${host.integrationSourcesTable}
        WHERE integration_task_id=$1
        ORDER BY id`,
      [integrationTaskId],
    );
    if (!preview.rows.length) throw new TaskboardNotFoundError('Integration Agent has no sources to finalize');
    const sourceIds = preview.rows.map((row) => String(row.id));
    const remediationRows = await client.query(
      `SELECT DISTINCT integration_source_id,remediation_task_id
         FROM ${host.remediationAttemptsTable}
        WHERE integration_source_id=ANY($1::text[]) AND state IN ('active','resolved')`,
      [sourceIds],
    );
    const remediationPairs = [...new Map<string, { sourceId: string; taskId: string }>([
      ...preview.rows
        .filter((row) => row.remediation_task_id)
        .map((row): [string, { sourceId: string; taskId: string }] => [
          `${row.id}:${row.remediation_task_id}`,
          { sourceId: String(row.id), taskId: String(row.remediation_task_id) },
        ]),
      ...remediationRows.rows.map((row): [string, { sourceId: string; taskId: string }] => [
        `${row.integration_source_id}:${row.remediation_task_id}`,
        { sourceId: String(row.integration_source_id), taskId: String(row.remediation_task_id) },
      ]),
    ]).values()];
    const deliveryTaskIds = preview.rows.map((row) => String(row.delivery_task_id));
    const aggregateTaskIds = [...new Set([integrationTaskId, ...deliveryTaskIds, ...remediationPairs.map((pair) => pair.taskId)])].sort();

    // Global lock order is Task -> Source/Agent -> Execution/Attempt.
    await client.query(
      `SELECT id FROM ${host.tasksTable} WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`,
      [aggregateTaskIds],
    );
    const agentResult = await client.query(
      `SELECT * FROM ${agentsTable} WHERE integration_task_id=$1 FOR UPDATE`,
      [integrationTaskId],
    );
    const agent = agentResult.rows[0];
    if (!agent || agent.status !== 'ready_to_merge' || agent.verdict !== 'approved'
      || String(agent.provider_pull_request_id ?? '') !== input.expectedAgent.providerPullRequestId
      || String(agent.integration_branch ?? '') !== input.expectedAgent.integrationBranch
      || String(agent.review_head_oid ?? '') !== input.event.reviewHeadOid
      || String(agent.review_execution_id ?? '') !== input.event.reviewExecutionId
      || String(agent.merge_in_flight_execution_id ?? '') !== input.event.executionId
      || String(agent.merge_in_flight_review_execution_id ?? '') !== input.event.reviewExecutionId
      || String(agent.merge_in_flight_review_head_oid ?? '') !== input.event.reviewHeadOid) {
      throw new TaskboardValidationError('Integration Agent changed during merge reconciliation', 'TASKBOARD_SUBJECT_STALE');
    }
    const mergeReceipt = jsonObject(agent.merge_receipt);
    const boundFacts = jsonObject(input.raw.providerFacts);
    const boundRevision = jsonObject(input.raw.approvedRevision);
    if (!mergeReceipt || String(mergeReceipt.providerRequestId ?? '') !== input.providerRequestId
      || String(mergeReceipt.providerPullRequestId ?? '') !== input.expectedAgent.providerPullRequestId
      || String(mergeReceipt.integrationBranch ?? '') !== input.expectedAgent.integrationBranch
      || String(mergeReceipt.reviewHeadOid ?? '') !== input.event.reviewHeadOid
      || String(mergeReceipt.reviewExecutionId ?? '') !== input.event.reviewExecutionId
      || String(mergeReceipt.executionId ?? '') !== input.event.executionId
      || String(mergeReceipt.runId ?? '') !== input.event.runId
      || String(mergeReceipt.mergedCommitOid ?? '') !== input.mergedCommitOid
      || !sameJson(mergeReceipt.raw, input.raw)
      || String(input.raw.providerRequestId ?? '') !== input.providerRequestId
      || String(input.raw.providerPullRequestId ?? '') !== input.expectedAgent.providerPullRequestId
      || String(input.raw.mergedCommitOid ?? '') !== input.mergedCommitOid
      || String(boundRevision?.headOid ?? '') !== input.event.reviewHeadOid
      || String(boundFacts?.providerPullRequestId ?? '') !== input.expectedAgent.providerPullRequestId
      || String(boundFacts?.headOid ?? '') !== input.event.reviewHeadOid
      || String(boundFacts?.mergeCommitOid ?? '') !== input.mergedCommitOid
      || String(boundFacts?.mergedTreeOid ?? '') !== String(boundRevision?.treeOid ?? '')
      || String(boundFacts?.baseOid ?? '') !== String(boundRevision?.baseOid ?? '')
      || boundFacts?.state !== 'merged') {
      throw new TaskboardValidationError('Stored merge receipt is not bound to provider facts', 'TASKBOARD_MERGE_RECEIPT_CONFLICT');
    }
    const sourcesResult = await client.query(
      `SELECT * FROM ${host.integrationSourcesTable}
        WHERE integration_task_id=$1
        ORDER BY id
        FOR UPDATE`,
      [integrationTaskId],
    );
    if (sourcesResult.rows.length !== sourceIds.length) {
      throw new TaskboardValidationError('Integration sources changed during merge reconciliation', 'TASKBOARD_SUBJECT_STALE');
    }
    const conflicting = sourcesResult.rows.find((source) => source.state === 'merged'
      && String(source.merged_commit_oid ?? '') !== input.mergedCommitOid);
    if (conflicting) {
      throw new TaskboardValidationError(
        'Merge receipt conflicts with the canonical merged commit',
        'TASKBOARD_MERGE_RECEIPT_CONFLICT',
      );
    }

    await client.query(
      `UPDATE ${host.integrationSourcesTable}
          SET state='merged',provider_receipt_id=$2,merged_commit_oid=$3,last_error=NULL,updated_at=now()
        WHERE integration_task_id=$1 AND state<>'merged'`,
      [integrationTaskId, input.providerRequestId, input.mergedCommitOid],
    );
    await client.query(
      `UPDATE ${host.mergeOperationsTable}
          SET state='reconciled',provider_request_id=$2,provider_receipt=$3::jsonb,
              merged_commit_oid=$4,error=NULL,updated_at=now()
        WHERE integration_source_id=ANY($1::text[])`,
      [sourceIds, input.providerRequestId, JSON.stringify(input.raw), input.mergedCommitOid],
    );
    await client.query(
      `UPDATE ${host.tasksTable}
          SET status='done',merged_commit_oid=$2,completed_at=COALESCE(completed_at,now()),
              workflow_epoch=workflow_epoch+CASE WHEN status='done' THEN 0 ELSE 1 END,
              next_action='none',next_action_revision=next_action_revision+CASE WHEN status='done' THEN 0 ELSE 1 END,
              version=version+CASE WHEN status='done' THEN 0 ELSE 1 END,updated_at=now()
        WHERE id=ANY($1::text[]) AND (status<>'done' OR merged_commit_oid IS DISTINCT FROM $2)`,
      [deliveryTaskIds, input.mergedCommitOid],
    );
    for (const pair of remediationPairs) {
      await completeRemediationAfterMerge(host, client, {
        remediationTaskId: pair.taskId,
        sourceId: pair.sourceId,
        commandId: `integration-agent-merge:${integrationTaskId}:${pair.sourceId}:${pair.taskId}:${input.mergedCommitOid}`,
        mergedCommitOid: input.mergedCommitOid,
      });
    }
    await client.query(
      `UPDATE ${host.blockEpisodesTable} SET closed_at=COALESCE(closed_at,now())
        WHERE task_id=ANY($1::text[]) AND closed_at IS NULL`,
      [aggregateTaskIds],
    );
    await fenceTaskExecutions(
      host,
      client,
      aggregateTaskIds.filter((id) => id !== integrationTaskId),
      'merge_confirmed',
    );
    await fenceTaskExecutions(host, client, [integrationTaskId], 'integration_converged', input.exceptExecutionId);

    // Agent/integration terminal state, authorization revocation and lane release are
    // deliberately last: all dependent cleanup and fencing above must succeed first.
    await client.query(
      `UPDATE ${agentsTable}
          SET status='merged',merge_in_flight_execution_id=NULL,
              merge_in_flight_review_execution_id=NULL,merge_in_flight_review_head_oid=NULL,updated_at=now()
        WHERE integration_task_id=$1 AND status<>'merged'`,
      [integrationTaskId],
    );
    const taskResult = await client.query(
      `UPDATE ${host.tasksTable}
          SET status='done',merged_commit_oid=$2,completed_at=COALESCE(completed_at,now()),
              workflow_epoch=workflow_epoch+CASE WHEN status='done' THEN 0 ELSE 1 END,
              next_action='none',next_action_revision=next_action_revision+CASE WHEN status='done' THEN 0 ELSE 1 END,
              version=version+CASE WHEN status='done' THEN 0 ELSE 1 END,updated_at=now()
        WHERE id=$1 AND (status<>'done' OR merged_commit_oid IS DISTINCT FROM $2)
        RETURNING *`,
      [integrationTaskId, input.mergedCommitOid],
    );
    if (!taskResult.rows[0]) {
      const existing = await client.query(`SELECT * FROM ${host.tasksTable} WHERE id=$1`, [integrationTaskId]);
      if (!existing.rows[0]) throw new TaskboardNotFoundError('Integration task not found');
      taskResult.rows.push(existing.rows[0]);
    }
    await client.query(
      `UPDATE ${host.mergeAuthorizationsTable} SET revoked_at=COALESCE(revoked_at,now())
        WHERE integration_task_id=$1 AND revoked_at IS NULL`,
      [integrationTaskId],
    );
    await client.query(
      `UPDATE ${host.integrationLanesTable}
          SET active_integration_task_id=NULL,lease_id=NULL,epoch=epoch+1,updated_at=now()
        WHERE active_integration_task_id=$1`,
      [integrationTaskId],
    );
    await client.query(
      `INSERT INTO ${host.changesTable}(task_id,change_type,actor_type,actor_id,execution_id,payload)
       SELECT $1,'integration.agent.merge.succeeded','agent',$2,$3,$4::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM ${host.changesTable}
           WHERE task_id=$1 AND change_type='integration.agent.merge.succeeded'
             AND payload->>'mergedCommitOid'=$5
        )`,
      [integrationTaskId, input.event.runId, input.event.executionId, JSON.stringify({
        providerPullRequestId: input.expectedAgent.providerPullRequestId,
        reviewHeadOid: input.event.reviewHeadOid,
        reviewExecutionId: input.event.reviewExecutionId,
        mergedCommitOid: input.mergedCommitOid,
      }), input.mergedCommitOid],
    );
    return rowToTask(taskResult.rows[0]!);
  });
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function withIntegrationTransaction<T>(
  host: IntegrationFinalizationHost,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await host.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
