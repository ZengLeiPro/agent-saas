import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { computeNextRunAtMs } from '../cron/scheduler.js';
import type { TaskboardIntegrationDispatchCandidate, TaskboardIdentity } from './types.js';
import { createIntegrationBatch } from './v2Store.js';
import { integrationAgentTableNames } from './integrationAgentSchema.js';
import { rowToTask, visibleCommentPredicate } from './storeHelpers.js';
import { purposeForIntegrationAgentStatus } from './workflow/decider.js';

interface IntegrationTriggerHost {
  pool: {
    connect(): Promise<PoolClient>;
    query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  };
  boardsTable: string;
  tasksTable: string;
  commentsTable: string;
  executionsTable: string;
  membersTable: string;
  changesTable: string;
  integrationLanesTable: string;
  integrationSourcesTable: string;
  mergeAuthorizationsTable: string;
  mergeOperationsTable: string;
  blockEpisodesTable: string;
  integrationTriggerOutboxTable: string;
  remediationAttemptsTable: string;
  cancellationOutboxTable: string;
}

export async function claimIntegrationDispatchCandidates(
  host: IntegrationTriggerHost,
  limit = 10,
): Promise<TaskboardIntegrationDispatchCandidate[]> {
  await enqueueScheduledTriggers(host);
  for (let index = 0; index < limit; index += 1) {
    const trigger = await claimTrigger(host);
    if (!trigger) break;
    const identity: TaskboardIdentity = {
      tenantId: trigger.tenantId,
      ownerUserId: trigger.ownerUserId,
      username: 'board-owner',
    };
    try {
      if (trigger.activeIntegrationTaskId) {
        await releaseTrigger(host, trigger.id, 30_000);
        continue;
      }
      const sources = await eligibleSources(host, trigger.boardId, trigger.maxTasks);
      if (!sources.length) {
        await completeTrigger(host, trigger);
        continue;
      }
      await createIntegrationBatch(host, identity, trigger.boardId, {
        deliveryTaskIds: sources,
        expectedBoardVersion: trigger.boardVersion,
      }, trigger.mode === 'scheduled' ? 'scheduled_policy' : 'on_ready_policy');
      await completeTrigger(host, trigger);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : '';
      if (code === 'TASKBOARD_INTEGRATION_ACTIVE' || code === 'TASKBOARD_VERSION_CONFLICT') {
        await releaseTrigger(host, trigger.id, 30_000);
      } else {
        await failTrigger(host, trigger.id, error instanceof Error ? error.message : String(error));
      }
    }
  }
  const candidates = await loadUnstartedIntegrationTasks(host, limit);
  return candidates.filter((candidate, index) => candidates.findIndex((item) => item.task.id === candidate.task.id) === index);
}

async function enqueueScheduledTriggers(host: IntegrationTriggerHost): Promise<void> {
  const client = await host.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT id, integration_policy, integration_next_run_at
         FROM ${host.boardsTable}
        WHERE archived_at IS NULL
          AND integration_policy->>'enabled'='true'
          AND integration_policy->'trigger'->>'mode'='scheduled'
        FOR UPDATE`,
    );
    const now = Date.now();
    for (const row of result.rows) {
      const policy = jsonObject(row.integration_policy) as {
        revision?: string;
        trigger?: { cron?: string; timezone?: string };
      } | undefined;
      const expr = policy?.trigger?.cron;
      if (!expr || !policy?.revision) continue;
      const nextAt = row.integration_next_run_at
        ? new Date(String(row.integration_next_run_at)).getTime()
        : computeNextRunAtMs({ kind: 'cron', expr, tz: policy.trigger?.timezone }, now);
      if (!nextAt) continue;
      if (nextAt <= now) {
        await client.query(
          `INSERT INTO ${host.integrationTriggerOutboxTable}
             (id, board_id, trigger_mode, policy_revision)
           VALUES ($1,$2,'scheduled',$3)
           ON CONFLICT DO NOTHING`,
          [randomUUID(), row.id, policy.revision],
        );
      }
      const following = computeNextRunAtMs({ kind: 'cron', expr, tz: policy.trigger?.timezone }, Math.max(now, nextAt));
      await client.query(
        `UPDATE ${host.boardsTable} SET integration_next_run_at=$2, updated_at=updated_at WHERE id=$1`,
        [row.id, following ? new Date(following) : null],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function claimTrigger(host: IntegrationTriggerHost): Promise<{
  id: string;
  boardId: string;
  mode: 'scheduled' | 'on_ready';
  tenantId: string;
  ownerUserId: string;
  boardVersion: number;
  policyRevision: string;
  maxTasks: number;
  activeIntegrationTaskId?: string;
} | undefined> {
  const client = await host.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE ${host.integrationTriggerOutboxTable}
          SET status='pending', lease_id=NULL, lease_expires_at=NULL, updated_at=now()
        WHERE status='processing' AND lease_expires_at<now()`,
    );
    const leaseId = randomUUID();
    const result = await client.query(
      `WITH candidate AS (
         SELECT o.id
           FROM ${host.integrationTriggerOutboxTable} o
          WHERE o.status='pending' AND o.available_at<=now()
          ORDER BY o.available_at,o.created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE ${host.integrationTriggerOutboxTable} o
          SET status='processing', lease_id=$1, lease_expires_at=now()+interval '2 minutes', updated_at=now()
         FROM candidate c
        WHERE o.id=c.id
        RETURNING o.*`,
      [leaseId],
    );
    const row = result.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return undefined;
    }
    const board = await client.query(
      `SELECT b.tenant_id,b.owner_user_id,b.version,b.integration_policy,
              l.active_integration_task_id
         FROM ${host.boardsTable} b
         LEFT JOIN ${host.integrationLanesTable} l ON l.board_id=b.id
        WHERE b.id=$1`,
      [row.board_id],
    );
    await client.query('COMMIT');
    const boardRow = board.rows[0];
    if (!boardRow) return undefined;
    const policy = jsonObject(boardRow.integration_policy) as { batch?: { maxTasks?: number } } | undefined;
    return {
      id: String(row.id),
      boardId: String(row.board_id),
      mode: row.trigger_mode === 'scheduled' ? 'scheduled' : 'on_ready',
      tenantId: String(boardRow.tenant_id),
      ownerUserId: String(boardRow.owner_user_id),
      boardVersion: Number(boardRow.version),
      policyRevision: String(row.policy_revision),
      maxTasks: Math.max(1, Number(policy?.batch?.maxTasks ?? 20)),
      ...(boardRow.active_integration_task_id
        ? { activeIntegrationTaskId: String(boardRow.active_integration_task_id) }
        : {}),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function eligibleSources(host: IntegrationTriggerHost, boardId: string, limit: number): Promise<string[]> {
  const client = await host.pool.connect();
  try {
    const result = await client.query(
      `SELECT t.id
         FROM ${host.tasksTable} t
        WHERE t.board_id=$1 AND t.kind='delivery' AND t.status='ready_to_merge'
          AND t.archived_at IS NULL
          AND t.provider_pull_request_id IS NOT NULL
          AND t.reviewed_subject_digest IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${host.integrationSourcesTable} s
             WHERE s.delivery_task_id=t.id AND s.state NOT IN ('merged','canceled')
          )
        ORDER BY
          CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
          t.updated_at,t.identifier
        LIMIT $2`,
      [boardId, limit],
    );
    return result.rows.map((row) => String(row.id));
  } finally {
    client.release();
  }
}

async function loadUnstartedIntegrationTasks(
  host: IntegrationTriggerHost,
  limit: number,
): Promise<TaskboardIntegrationDispatchCandidate[]> {
  if (limit <= 0) return [];
  const { agentsTable } = integrationAgentTableNames(host.integrationSourcesTable);
  const client = await host.pool.connect();
  try {
    await client.query('BEGIN');
    // Historical v2 rows are upgraded in the same transaction that creates their
    // durable rendezvous. Existing source rows already contain the frozen source IDs
    // needed by the Agent, so retries can safely converge through ON CONFLICT.
    await client.query(
      `WITH candidates AS (
         SELECT t.id
           FROM ${host.tasksTable} t
           JOIN ${host.integrationLanesTable} lane ON lane.active_integration_task_id=t.id
          WHERE t.kind='integration' AND COALESCE(t.workflow_version,2)=2
            AND t.status IN ('todo','in_progress')
            AND t.archived_at IS NULL AND t.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM ${host.executionsTable} e
               WHERE e.task_id=t.id AND e.status IN ('queued','running','waiting_user','waiting_approval')
            )
          FOR UPDATE OF t SKIP LOCKED
       )
       INSERT INTO ${agentsTable}
         (integration_task_id,delivery_source_ids,repository_id,integration_branch,status)
       SELECT candidate.id,jsonb_agg(source.id ORDER BY source.source_order),min(source.repository_id),
              'integration/' || candidate.id,'active'
         FROM candidates candidate
         JOIN ${host.integrationSourcesTable} source ON source.integration_task_id=candidate.id
        GROUP BY candidate.id
       HAVING count(*)>0 AND count(DISTINCT source.repository_id)=1
       ON CONFLICT (integration_task_id) DO NOTHING`,
    );
    // Keep the statements separate: PostgreSQL data-modifying CTEs share a snapshot,
    // while the immutable-version trigger must observe the rendezvous just inserted.
    await client.query(
      `UPDATE ${host.tasksTable} task
          SET workflow_version=3,version=version+1,updated_at=now()
         FROM ${agentsTable} agent
         JOIN ${host.integrationLanesTable} lane
           ON lane.active_integration_task_id=agent.integration_task_id
          AND lane.repository_id=agent.repository_id
        WHERE task.id=agent.integration_task_id
          AND task.board_id=lane.board_id
          AND task.kind='integration' AND COALESCE(task.workflow_version,2)=2
          AND task.status IN ('todo','in_progress')
          AND task.archived_at IS NULL AND task.deleted_at IS NULL
          AND agent.integration_branch='integration/' || task.id
          AND agent.delivery_source_ids=(
            SELECT jsonb_agg(source.id ORDER BY source.source_order)
              FROM ${host.integrationSourcesTable} source
             WHERE source.integration_task_id=task.id
          )
          AND agent.repository_id=(
            SELECT min(source.repository_id)
              FROM ${host.integrationSourcesTable} source
             WHERE source.integration_task_id=task.id
            HAVING count(*)>0 AND count(DISTINCT source.repository_id)=1
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${host.executionsTable} execution
             WHERE execution.task_id=task.id
               AND execution.status IN ('queued','running','waiting_user','waiting_approval')
          )`,
    );
    const result = await client.query(
      `SELECT t.*, b.tenant_id, b.owner_user_id,
              (SELECT count(*)::int FROM ${host.commentsTable} c WHERE c.task_id=t.id AND ${visibleCommentPredicate('c', host.changesTable)}) AS comment_count
         FROM ${host.tasksTable} t
         JOIN ${host.boardsTable} b ON b.id=t.board_id
         LEFT JOIN ${host.integrationLanesTable} l ON l.active_integration_task_id=t.id
        WHERE (
            (t.kind='integration' AND t.workflow_version=3
                AND t.status IN ('todo','in_progress','in_review','ready_to_merge')
                AND l.active_integration_task_id=t.id
                AND EXISTS (
                  SELECT 1 FROM ${agentsTable} agent
                   WHERE agent.integration_task_id=t.id
                     AND (
                       (t.status IN ('todo','in_progress') AND agent.status='active')
                       OR (t.status='in_review' AND agent.status='reviewing')
                       OR (t.status='ready_to_merge' AND agent.status='ready_to_merge'
                           AND agent.verdict='approved' AND agent.review_execution_id IS NOT NULL
                           AND agent.review_head_oid IS NOT NULL)
                     )
                ))
            OR (t.kind='delivery' AND t.status='in_review'
                AND t.provider_pull_request_id IS NOT NULL)
            OR (t.kind='delivery' AND t.status='todo'
                AND (
                  (EXISTS (
                    SELECT 1 FROM ${host.executionsTable} retry_execution
                     WHERE retry_execution.task_id=t.id AND retry_execution.purpose='work'
                       AND retry_execution.protocol_version=2 AND retry_execution.status='failed'
                       AND retry_execution.finished_at=(
                         SELECT MAX(latest_retry.finished_at) FROM ${host.executionsTable} latest_retry
                          WHERE latest_retry.task_id=t.id AND latest_retry.purpose='work'
                       )
                  )
                  AND (SELECT count(*) FROM ${host.executionsTable} retry_count
                        WHERE retry_count.task_id=t.id AND retry_count.purpose='work'
                          AND retry_count.protocol_version=2 AND retry_count.status='failed')
                      <= COALESCE((b.integration_policy->'execution'->>'maxTransientRetries')::int,3))
                  OR EXISTS (
                    SELECT 1 FROM ${host.changesTable} rework_change
                     WHERE rework_change.task_id=t.id
                       AND rework_change.change_type IN ('execution.transitioned','execution.transitioned.v3')
                       AND rework_change.payload->>'status'='todo'
                       AND NOT EXISTS (
                         SELECT 1 FROM ${host.executionsTable} rework_execution
                          WHERE rework_execution.task_id=t.id AND rework_execution.purpose='work'
                            AND rework_execution.created_at>rework_change.created_at
                       )
                  )
                ))
          )
          -- 归档/删除是 in_review 任务唯一的人工出口（moveTask 对该状态硬拒），
          -- 这里漏掉过滤会让已归档任务被无限重新调度，人工无从叫停。
          AND t.archived_at IS NULL
          AND t.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${host.executionsTable} e
             WHERE e.task_id=t.id AND e.status IN ('queued','running','waiting_user','waiting_approval')
          )
        ORDER BY t.created_at
        LIMIT $1`,
      [limit],
    );
    await client.query('COMMIT');
    return result.rows.map((row) => ({
      identity: {
        tenantId: String(row.tenant_id),
        ownerUserId: String(row.owner_user_id),
        username: 'board-owner',
      },
      task: rowToTask(row),
      purpose: row.kind === 'integration'
        ? purposeForIntegrationAgentStatus(rowToTask(row).status)!
        : row.status === 'in_review' ? 'review' : 'work',
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function completeTrigger(
  host: IntegrationTriggerHost,
  trigger: { id: string; boardId: string; mode: 'scheduled' | 'on_ready'; policyRevision: string },
): Promise<void> {
  const client = await host.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE ${host.integrationTriggerOutboxTable}
          SET status='completed', lease_id=NULL, lease_expires_at=NULL, last_error=NULL, updated_at=now()
        WHERE id=$1`,
      [trigger.id],
    );
    if (trigger.mode === 'on_ready') {
      await client.query(
        `INSERT INTO ${host.integrationTriggerOutboxTable}
           (id,board_id,trigger_mode,policy_revision)
         SELECT $1,$2,'on_ready',$3
          WHERE EXISTS (
            SELECT 1 FROM ${host.tasksTable} t
             WHERE t.board_id=$2 AND t.kind='delivery' AND t.status='ready_to_merge'
               AND t.archived_at IS NULL
               AND t.provider_pull_request_id IS NOT NULL
               AND t.reviewed_subject_digest IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM ${host.integrationSourcesTable} s
                  WHERE s.delivery_task_id=t.id AND s.state NOT IN ('merged','canceled')
               )
          )
         ON CONFLICT DO NOTHING`,
        [randomUUID(), trigger.boardId, trigger.policyRevision],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function releaseTrigger(host: IntegrationTriggerHost, id: string, delayMs: number): Promise<void> {
  const client = await host.pool.connect();
  try {
    await client.query(
      `UPDATE ${host.integrationTriggerOutboxTable}
          SET status='pending', available_at=now()+($2::bigint * interval '1 millisecond'),
              lease_id=NULL, lease_expires_at=NULL, updated_at=now()
        WHERE id=$1`,
      [id, delayMs],
    );
  } finally {
    client.release();
  }
}

async function failTrigger(host: IntegrationTriggerHost, id: string, error: string): Promise<void> {
  const client = await host.pool.connect();
  try {
    await client.query(
      `UPDATE ${host.integrationTriggerOutboxTable}
          SET status='failed', last_error=$2, lease_id=NULL, lease_expires_at=NULL, updated_at=now()
        WHERE id=$1`,
      [id, error],
    );
  } finally {
    client.release();
  }
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
