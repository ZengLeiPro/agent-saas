import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { computeNextRunAtMs } from '../cron/scheduler.js';
import type { TaskboardIntegrationDispatchCandidate, TaskboardIdentity } from './types.js';
import { createIntegrationBatch } from './v2Store.js';
import { integrationAgentTableNames } from './integrationAgentSchema.js';
import { ensureLegacyIntegrationAgentRendezvous } from './legacyIntegrationAgentMigration.js';
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
      // Agent-first integrations enter through the durable rendezvous and are
      // picked up below; legacy integrations still start directly with merge.
      if ((task.workflowVersion ?? 2) === 2) created.push({ identity, task, purpose: 'merge' });
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
  const recoveryLimit = Math.max(0, limit - created.length);
  const recoveries = await createAutomaticRemediationCandidates(host, recoveryLimit);
  const recoverable = await loadUnstartedIntegrationTasks(
    host,
    Math.max(0, recoveryLimit - recoveries.length),
  );
  const candidates = [...created, ...recoveries, ...recoverable];
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

async function createAutomaticRemediationCandidates(
  host: IntegrationTriggerHost,
  limit: number,
): Promise<TaskboardIntegrationDispatchCandidate[]> {
  if (limit <= 0) return [];
  const result = await host.pool.query(
    `SELECT s.id AS source_id,s.integration_task_id,s.delivery_task_id,s.remediation_count,
            i.status AS integration_status,d.identifier AS delivery_identifier,d.title AS delivery_title,
            d.description AS delivery_description,d.branch,d.provider_pull_request_id,d.pull_request_number,
            d.head_oid,d.base_oid,d.model,i.board_id,b.tenant_id,b.owner_user_id,b.integration_policy
       FROM ${host.integrationSourcesTable} s
       JOIN ${host.tasksTable} i ON i.id=s.integration_task_id
       JOIN ${host.tasksTable} d ON d.id=s.delivery_task_id
       JOIN ${host.boardsTable} b ON b.id=i.board_id
      WHERE (s.state='resolving_conflict'
             OR (s.state='waiting_retry' AND s.last_error LIKE 'Required checks failed%'))
        AND s.remediation_task_id IS NULL
        AND i.kind='integration' AND COALESCE(i.workflow_version,2)=2 AND i.status IN ('todo','in_progress')
        AND NOT EXISTS (
          SELECT 1 FROM ${host.executionsTable} e
           WHERE e.task_id=i.id AND e.status IN ('queued','running','waiting_user','waiting_approval')
        )
      ORDER BY s.updated_at,s.source_order,s.id
      LIMIT $1`,
    [limit],
  );
  const candidates: TaskboardIntegrationDispatchCandidate[] = [];
  for (const row of result.rows) {
    const policy = jsonObject(row.integration_policy) as {
      execution?: { autoResolveConflicts?: boolean; maxAutomaticRemediationRounds?: number };
    } | undefined;
    if (policy?.execution?.autoResolveConflicts === false) continue;
    const maxRounds = Math.max(0, Number(policy?.execution?.maxAutomaticRemediationRounds ?? 3));
    if (Number(row.remediation_count ?? 0) >= maxRounds) {
      await markAutomaticRecoveryExhausted(host, String(row.source_id));
      continue;
    }
    const task = await createAutomaticRemediationTask(host, row, maxRounds);
    if (!task) continue;
    candidates.push({
      identity: {
        tenantId: String(row.tenant_id),
        ownerUserId: String(row.owner_user_id),
        username: 'board-owner',
      },
      task,
      purpose: 'work',
    });
  }
  return candidates;
}

async function createAutomaticRemediationTask(
  host: IntegrationTriggerHost,
  candidate: Record<string, unknown>,
  maxRounds: number,
): Promise<ReturnType<typeof rowToTask> | undefined> {
  const client = await host.pool.connect();
  try {
    await client.query('BEGIN');
    const taskIds = [String(candidate.integration_task_id), String(candidate.delivery_task_id)].sort();
    await client.query(
      `SELECT id FROM ${host.tasksTable} WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`,
      [taskIds],
    );
    const sourceResult = await client.query(
      `SELECT s.*,i.board_id AS board_id,i.status AS integration_status,
              d.identifier AS delivery_identifier,d.title AS delivery_title,d.description AS delivery_description,
              d.branch,d.provider_pull_request_id,d.pull_request_number,d.head_oid,d.base_oid,d.model,
              b.tenant_id,b.owner_user_id,b.integration_policy
         FROM ${host.integrationSourcesTable} s
         JOIN ${host.tasksTable} i ON i.id=s.integration_task_id
         JOIN ${host.tasksTable} d ON d.id=s.delivery_task_id
         JOIN ${host.boardsTable} b ON b.id=i.board_id
        WHERE s.id=$1
        FOR UPDATE OF s`,
      [String(candidate.source_id)],
    );
    const source = sourceResult.rows[0];
    if (!source
      || !['todo', 'in_progress'].includes(String(source.integration_status))
      || !['resolving_conflict', 'waiting_retry'].includes(String(source.state))
      || (String(source.state) === 'waiting_retry' && !String(source.last_error ?? '').startsWith('Required checks failed'))
      || source.remediation_task_id) {
      await client.query('ROLLBACK');
      return undefined;
    }
    if (Number(source.remediation_count ?? 0) >= maxRounds) {
      await client.query(
        `UPDATE ${host.integrationSourcesTable}
            SET state='needs_human',last_error='Automatic remediation rounds exhausted; human intervention is required',updated_at=now()
          WHERE id=$1 AND state<>'merged' AND merged_commit_oid IS NULL AND provider_receipt_id IS NULL`,
        [String(candidate.source_id)],
      );
      await client.query('COMMIT');
      return undefined;
    }
    const round = Math.max(1, Number(source.remediation_count ?? 0) + 1);
    const nextNumber = await client.query(
      `UPDATE ${host.boardsTable}
          SET next_task_number=next_task_number+1,version=version+1,updated_at=now()
        WHERE id=$1
        RETURNING next_task_number-1 AS task_number`,
      [source.board_id],
    );
    if (!nextNumber.rows[0]) throw new Error('Taskboard board not found for automatic remediation');
    const tail = await client.query(
      `SELECT COALESCE(MAX(sort_order),0) AS max_sort_order
         FROM ${host.tasksTable}
        WHERE board_id=$1 AND status='todo' AND archived_at IS NULL`,
      [source.board_id],
    );
    const taskId = randomUUID();
    const clientRequestId = `taskboard-auto-remediation:${String(source.id)}:${round}`;
    await client.query(
      `INSERT INTO ${host.tasksTable}
         (id,board_id,identifier,kind,title,description,branch,attachments,status,priority,labels,
          sort_order,model,provider_pull_request_id,pull_request_number,head_oid,base_oid,creator_user_id,creator_name,
          client_request_id,version)
       VALUES ($1,$2,$3,'remediation',$4,$5,$6,'[]'::jsonb,'todo','high',ARRAY['integration','remediation']::text[],
               $7,$8,$9,$10,$11,$12,$13,$14,$15,1)`,
      [
        taskId, source.board_id, `TASK-${Number(nextNumber.rows[0].task_number)}`,
        `修复集成来源：${String(source.delivery_identifier)}`,
        [
          `自动修复来源 ${String(source.id)} 的集成阻塞。`,
          `沿用原分支 ${String(source.branch ?? '(未登记)')} 和 PR #${String(source.provider_pull_request_id)}。`,
          '完成代码修复并验证后，必须登记当前 PR，再提交 ready_for_review；系统随后自动复核并恢复 merge。',
        ].join('\n'),
        source.branch ?? null,
        Number(tail.rows[0]?.max_sort_order ?? 0) + 1024,
        source.model ?? null,
        String(source.provider_pull_request_id), source.pull_request_number ?? null,
        source.head_oid ?? null, source.base_oid ?? null,
        String(source.owner_user_id), 'Taskboard Agent', clientRequestId,
      ],
    );
    await client.query(
      `INSERT INTO ${host.remediationAttemptsTable}
         (id,integration_source_id,round,remediation_task_id,state,base_head_oid)
       VALUES ($1,$2,$3,$4,'active',$5)`,
      [randomUUID(), String(source.id), round, taskId, source.head_oid ?? null],
    );
    await client.query(
      `UPDATE ${host.integrationSourcesTable}
          SET remediation_task_id=$2,state='waiting_remediation',last_error=NULL,updated_at=now()
        WHERE id=$1 AND state IN ('resolving_conflict','waiting_retry') AND remediation_task_id IS NULL
        RETURNING id`,
      [String(source.id), taskId],
    );
    await client.query(
      `INSERT INTO ${host.changesTable}
         (task_id,change_type,actor_type,actor_id,payload)
       VALUES ($1,'integration.remediation_created','system',$2,$3::jsonb)`,
      [String(source.integration_task_id), String(source.id), JSON.stringify({
        sourceId: String(source.id), remediationTaskId: taskId, round,
      })],
    );
    const taskResult = await client.query(
      `SELECT t.*,
              (SELECT count(*)::int FROM ${host.commentsTable} c WHERE c.task_id=t.id) AS comment_count
         FROM ${host.tasksTable} t WHERE t.id=$1`,
      [taskId],
    );
    await client.query('COMMIT');
    return rowToTask(taskResult.rows[0]!);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function markAutomaticRecoveryExhausted(host: IntegrationTriggerHost, sourceId: string): Promise<void> {
  await host.pool.query(
    `UPDATE ${host.integrationSourcesTable}
        SET state='needs_human',last_error='Automatic remediation rounds exhausted; human intervention is required',updated_at=now()
      WHERE id=$1 AND state<>'merged' AND merged_commit_oid IS NULL AND provider_receipt_id IS NULL`,
    [sourceId],
  );
}

async function loadUnstartedIntegrationTasks(
  host: IntegrationTriggerHost,
  limit: number,
): Promise<TaskboardIntegrationDispatchCandidate[]> {
  if (limit <= 0) return [];
  const { agentsTable } = integrationAgentTableNames(host.integrationSourcesTable);
  const client = await host.pool.connect();
  try {
    // A v3 task can predate the Agent rendezvous table. Repair that one-way
    // compatibility gap during the scanner pass so scheduling does not depend on
    // a user opening context or issuing resume first.
    await client.query('BEGIN');
    const legacyTasks = await client.query(
      `SELECT t.*,
              (SELECT count(*)::int FROM ${host.commentsTable} c WHERE c.task_id=t.id AND ${visibleCommentPredicate('c', host.changesTable)}) AS comment_count
         FROM ${host.tasksTable} t
         JOIN ${host.integrationLanesTable} l ON l.active_integration_task_id=t.id
        WHERE t.kind='integration' AND COALESCE(t.workflow_version,2)=3
          AND t.status IN ('todo','in_progress','in_review','ready_to_merge')
          AND t.archived_at IS NULL AND t.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM ${agentsTable} agent WHERE agent.integration_task_id=t.id)
        ORDER BY t.created_at
        LIMIT $1
        FOR UPDATE OF t`,
      [limit],
    );
    for (const legacyTask of legacyTasks.rows) {
      await ensureLegacyIntegrationAgentRendezvous(host, client, rowToTask(legacyTask));
    }
    await client.query('COMMIT');

    const result = await client.query(
      `SELECT t.*, b.tenant_id, b.owner_user_id,
              (SELECT count(*)::int FROM ${host.commentsTable} c WHERE c.task_id=t.id AND ${visibleCommentPredicate('c', host.changesTable)}) AS comment_count
         FROM ${host.tasksTable} t
         JOIN ${host.boardsTable} b ON b.id=t.board_id
         LEFT JOIN ${host.integrationLanesTable} l ON l.active_integration_task_id=t.id
        WHERE (
            (t.kind='integration' AND COALESCE(t.workflow_version,2)=2
             AND t.status IN ('todo','in_progress') AND l.active_integration_task_id=t.id
             AND NOT EXISTS (
               SELECT 1 FROM ${host.integrationSourcesTable} blocked_source
                WHERE blocked_source.integration_task_id=t.id
                  AND (
                    blocked_source.state IN ('waiting_remediation','re_reviewing','merging','resolving_conflict','needs_human')
                    OR EXISTS (
                      SELECT 1 FROM ${host.mergeOperationsTable} blocked_operation
                       WHERE blocked_operation.integration_source_id=blocked_source.id
                         AND blocked_operation.state IN ('executing','unknown')
                    )
                  )
             ))
            OR (t.kind='integration' AND COALESCE(t.workflow_version,2)=3
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
            OR (t.kind IN ('delivery','remediation') AND t.status='in_review'
                AND t.provider_pull_request_id IS NOT NULL)
            OR (t.kind='remediation' AND t.status='todo'
                AND EXISTS (
                  SELECT 1 FROM ${host.integrationSourcesTable} linked_source
                   WHERE linked_source.remediation_task_id=t.id
                     AND linked_source.state='waiting_remediation'
                ))
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
    return result.rows.map((row) => ({
      identity: {
        tenantId: String(row.tenant_id),
        ownerUserId: String(row.owner_user_id),
        username: 'board-owner',
      },
      task: rowToTask(row),
      purpose: row.kind === 'integration'
        ? Number(row.workflow_version ?? 2) === 2
          ? 'merge'
          : purposeForIntegrationAgentStatus(rowToTask(row).status)!
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
