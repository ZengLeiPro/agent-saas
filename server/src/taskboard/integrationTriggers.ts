import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { computeNextRunAtMs } from '../cron/scheduler.js';
import type { TaskboardIntegrationDispatchCandidate, TaskboardIdentity } from './types.js';
import { createIntegrationBatch } from './v2Store.js';
import { rowToTask } from './storeHelpers.js';

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
  resolutionsTable: string;
  remediationAttemptsTable: string;
  cancellationOutboxTable: string;
}

export async function claimIntegrationDispatchCandidates(
  host: IntegrationTriggerHost,
  limit = 10,
): Promise<TaskboardIntegrationDispatchCandidate[]> {
  await enqueueScheduledTriggers(host);
  const created: TaskboardIntegrationDispatchCandidate[] = [];
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
      const task = await createIntegrationBatch(host, identity, trigger.boardId, {
        deliveryTaskIds: sources,
        expectedBoardVersion: trigger.boardVersion,
      }, trigger.mode === 'scheduled' ? 'scheduled_policy' : 'on_ready_policy');
      await completeTrigger(host, trigger);
      created.push({ identity, task, purpose: 'merge' });
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
  const recoverable = await loadUnstartedIntegrationTasks(host, Math.max(0, limit - created.length));
  return [...created, ...recoverable];
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
  const client = await host.pool.connect();
  try {
    const result = await client.query(
      `SELECT t.*, b.tenant_id, b.owner_user_id,
              (SELECT count(*)::int FROM ${host.commentsTable} c WHERE c.task_id=t.id) AS comment_count
         FROM ${host.tasksTable} t
         JOIN ${host.boardsTable} b ON b.id=t.board_id
         LEFT JOIN ${host.integrationLanesTable} l ON l.active_integration_task_id=t.id
        WHERE (
            (t.kind='integration' AND t.status IN ('todo','in_progress') AND l.active_integration_task_id=t.id
             AND NOT EXISTS (
               SELECT 1 FROM ${host.integrationSourcesTable} blocked_source
                WHERE blocked_source.integration_task_id=t.id
                  AND (
                    blocked_source.state IN ('waiting_remediation','re_reviewing','merging')
                    OR EXISTS (
                      SELECT 1 FROM ${host.mergeOperationsTable} blocked_operation
                       WHERE blocked_operation.integration_source_id=blocked_source.id
                         AND blocked_operation.state IN ('executing','unknown')
                    )
                  )
             ))
            OR (t.kind IN ('delivery','remediation') AND t.status='in_review'
                AND t.provider_pull_request_id IS NOT NULL)
            OR (t.kind IN ('delivery','remediation') AND t.status='todo'
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
                       AND rework_change.change_type IN ('execution.resolved','execution.resolved.v2')
                       AND rework_change.payload->>'outcome'='changes_requested'
                       AND NOT EXISTS (
                         SELECT 1 FROM ${host.executionsTable} rework_execution
                          WHERE rework_execution.task_id=t.id AND rework_execution.purpose='work'
                            AND rework_execution.created_at>rework_change.created_at
                       )
                  )
                ))
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${host.executionsTable} e
             WHERE e.task_id=t.id AND e.status IN ('queued','running','waiting_user','waiting_approval')
          )
        ORDER BY t.created_at
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      identity: {
        tenantId: String(row.tenant_id),
        ownerUserId: String(row.owner_user_id),
        username: 'board-owner',
      },
      task: rowToTask(row),
      purpose: row.kind === 'integration' ? 'merge' : row.status === 'in_review' ? 'review' : 'work',
    }));
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
