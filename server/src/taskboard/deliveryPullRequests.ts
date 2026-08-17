import type { PoolClient } from 'pg';

import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import type { RepositoryProvider } from './repositoryProvider.js';
import { rowToTask } from './storeHelpers.js';
import {
  TaskboardNotFoundError,
  TaskboardValidationError,
  type TaskboardIdentity,
} from './types.js';

interface DeliveryPullRequestHost {
  pool: { connect(): Promise<PoolClient> };
  boardsTable: string;
  tasksTable: string;
  commentsTable: string;
  executionsTable: string;
  changesTable: string;
  integrationSourcesTable: string;
  repositoryProvider?: RepositoryProvider;
}

export async function attachExecutionPullRequest(
  host: DeliveryPullRequestHost,
  identity: TaskboardIdentity,
  runId: string,
  providerPullRequestId: string,
): Promise<TaskBoardTask> {
  const context = await loadContext(host, identity, runId, ['work']);
  const provider = requireProvider(host);
  const pullRequest = await provider.getPullRequest(
    context.repository,
    providerPullRequestId,
    context.boardOwnerUserId,
  );
  if (pullRequest.state !== 'open') {
    throw new TaskboardValidationError('Delivery pull request must be open', 'TASKBOARD_PR_NOT_OPEN');
  }
  const client = await host.pool.connect();
  try {
    await client.query('BEGIN');
    await lockExecution(client, host, runId, context.taskId);
    const result = await client.query(
      `UPDATE ${host.tasksTable}
          SET provider_pull_request_id=$2, pull_request_number=$3,
              head_oid=$4, base_oid=$5, reviewed_subject_digest=NULL,
              version=version+1, updated_at=now()
        WHERE id=$1
        RETURNING *,
          (SELECT count(*)::int FROM ${host.commentsTable} c WHERE c.task_id=${host.tasksTable}.id) AS comment_count`,
      [context.taskId, pullRequest.providerPullRequestId, pullRequest.number, pullRequest.headOid, pullRequest.baseOid],
    );
    await client.query(
      `INSERT INTO ${host.changesTable}
         (task_id, change_type, actor_type, actor_id, execution_id, payload)
       VALUES ($1,'pull_request.attached','agent',$2,$3,$4::jsonb)`,
      [context.taskId, runId, context.executionId, JSON.stringify({
        providerPullRequestId: pullRequest.providerPullRequestId,
        number: pullRequest.number,
        headOid: pullRequest.headOid,
        baseOid: pullRequest.baseOid,
        subjectDigest: pullRequest.subjectDigest,
      })],
    );
    await client.query('COMMIT');
    return rowToTask(result.rows[0]!);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function recordReviewedExecutionSubject(
  host: DeliveryPullRequestHost,
  identity: TaskboardIdentity,
  runId: string,
): Promise<TaskBoardTask> {
  const context = await loadContext(host, identity, runId, ['review']);
  if (!context.providerPullRequestId) {
    throw new TaskboardValidationError('Delivery task has no pull request');
  }
  const provider = requireProvider(host);
  const pullRequest = await provider.getPullRequest(
    context.repository,
    context.providerPullRequestId,
    context.boardOwnerUserId,
  );
  if (pullRequest.state !== 'open' || pullRequest.draft) {
    throw new TaskboardValidationError('Pull request is not reviewable', 'TASKBOARD_PR_NOT_OPEN');
  }
  const client = await host.pool.connect();
  try {
    await client.query('BEGIN');
    await lockExecution(client, host, runId, context.taskId);
    const current = await client.query(
      `SELECT provider_pull_request_id FROM ${host.tasksTable} WHERE id=$1 FOR UPDATE`,
      [context.taskId],
    );
    if (current.rows[0]?.provider_pull_request_id !== context.providerPullRequestId) {
      throw new TaskboardValidationError('Pull request changed during review', 'TASKBOARD_SUBJECT_STALE');
    }
    const result = await client.query(
      `UPDATE ${host.tasksTable}
          SET pull_request_number=$2, head_oid=$3, base_oid=$4,
              reviewed_subject_digest=$5, version=version+1, updated_at=now()
        WHERE id=$1
        RETURNING *,
          (SELECT count(*)::int FROM ${host.commentsTable} c WHERE c.task_id=${host.tasksTable}.id) AS comment_count`,
      [context.taskId, pullRequest.number, pullRequest.headOid, pullRequest.baseOid, pullRequest.subjectDigest],
    );
    await client.query(
      `INSERT INTO ${host.changesTable}
         (task_id, change_type, actor_type, actor_id, execution_id, payload)
       VALUES ($1,'review.subject_recorded','agent',$2,$3,$4::jsonb)`,
      [context.taskId, runId, context.executionId, JSON.stringify({
        providerPullRequestId: pullRequest.providerPullRequestId,
        headOid: pullRequest.headOid,
        baseOid: pullRequest.baseOid,
        subjectDigest: pullRequest.subjectDigest,
      })],
    );
    await client.query(
      `UPDATE ${host.integrationSourcesTable}
          SET provider_pull_request_id=$2, reviewed_subject_digest=$3,
              state=CASE WHEN remediation_task_id=$1 THEN state ELSE 'pending' END,
              last_error=NULL, updated_at=now()
        WHERE (delivery_task_id=$1 AND state='re_reviewing')
           OR (remediation_task_id=$1 AND state='waiting_remediation')`,
      [context.taskId, pullRequest.providerPullRequestId, pullRequest.subjectDigest],
    );
    await client.query('COMMIT');
    return rowToTask(result.rows[0]!);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function loadContext(
  host: DeliveryPullRequestHost,
  identity: TaskboardIdentity,
  runId: string,
  purposes: string[],
): Promise<{
  taskId: string;
  executionId: string;
  providerPullRequestId?: string;
  repository: { provider: 'github'; repositoryId: string; owner: string; name: string; baseBranch: string; allowForkPullRequest: false };
  boardOwnerUserId: string;
}> {
  const client = await host.pool.connect();
  try {
    const result = await client.query(
      `SELECT t.id AS task_id,t.kind,t.provider_pull_request_id,
              e.id AS execution_id,e.purpose,e.status AS execution_status,
              b.repository,b.owner_user_id
         FROM ${host.executionsTable} e
         JOIN ${host.tasksTable} t ON t.id=e.task_id
         JOIN ${host.boardsTable} b ON b.id=t.board_id
        WHERE e.run_id=$1 AND b.tenant_id=$2
          AND (b.owner_user_id=$3 OR b.visibility='organization')
        LIMIT 1`,
      [runId, identity.tenantId, identity.ownerUserId],
    );
    const row = result.rows[0];
    if (!row) throw new TaskboardNotFoundError('Taskboard execution not found');
    if (!['delivery', 'remediation'].includes(String(row.kind)) || !purposes.includes(String(row.purpose))) {
      throw new TaskboardValidationError('Execution purpose cannot update task pull request');
    }
    if (!['queued', 'running', 'waiting_user', 'waiting_approval'].includes(String(row.execution_status))) {
      throw new TaskboardValidationError('Taskboard execution is no longer active');
    }
    const repository = jsonObject(row.repository);
    if (!repository || repository.provider !== 'github') {
      throw new TaskboardValidationError('Board repository is not configured');
    }
    return {
      taskId: String(row.task_id),
      executionId: String(row.execution_id),
      ...(row.provider_pull_request_id ? { providerPullRequestId: String(row.provider_pull_request_id) } : {}),
      repository: repository as {
        provider: 'github'; repositoryId: string; owner: string; name: string;
        baseBranch: string; allowForkPullRequest: false;
      },
      boardOwnerUserId: String(row.owner_user_id),
    };
  } finally {
    client.release();
  }
}

async function lockExecution(
  client: PoolClient,
  host: DeliveryPullRequestHost,
  runId: string,
  taskId: string,
): Promise<void> {
  const result = await client.query(
    `SELECT id FROM ${host.executionsTable}
      WHERE run_id=$1 AND task_id=$2
        AND status IN ('queued','running','waiting_user','waiting_approval')
      FOR UPDATE`,
    [runId, taskId],
  );
  if (!result.rows[0]) throw new TaskboardValidationError('Taskboard execution changed');
}

function requireProvider(host: DeliveryPullRequestHost): RepositoryProvider {
  if (!host.repositoryProvider) {
    throw new TaskboardValidationError('Repository provider is unavailable');
  }
  return host.repositoryProvider;
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
