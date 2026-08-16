import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type {
  TaskBoardIntegrationSource,
  TaskBoardRepositoryConfig,
} from '../../../shared/src/types/taskboard.js';
import type {
  RepositoryProvider,
  RepositoryPullRequestSnapshot,
} from './repositoryProvider.js';
import { rowToTask, toIso } from './storeHelpers.js';
import {
  TaskboardNotFoundError,
  TaskboardValidationError,
  type TaskboardIdentity,
} from './types.js';

export interface IntegrationOperationHost {
  pool: { connect(): Promise<PoolClient> };
  boardsTable: string;
  tasksTable: string;
  commentsTable: string;
  executionsTable: string;
  changesTable: string;
  integrationLanesTable: string;
  integrationSourcesTable: string;
  mergeAuthorizationsTable: string;
  mergeOperationsTable: string;
  repositoryProvider?: RepositoryProvider;
}

export interface IntegrationSourceInspection {
  source: TaskBoardIntegrationSource;
  pullRequest: RepositoryPullRequestSnapshot;
}

export async function inspectIntegrationSource(
  host: IntegrationOperationHost,
  identity: TaskboardIdentity,
  runId: string,
  sourceId: string,
): Promise<IntegrationSourceInspection> {
  const loaded = await loadOperationContext(host, identity, runId, sourceId);
  const provider = requireProvider(host);
  const pullRequest = await provider.getPullRequest(
    loaded.repository,
    loaded.source.providerPullRequestId,
    loaded.boardOwnerUserId,
  );
  if (loaded.source.state === 'merged' || loaded.source.state === 'needs_human') {
    return { source: loaded.source, pullRequest };
  }
  const nextState = pullRequest.subjectDigest !== loaded.source.reviewedSubjectDigest
    ? 're_reviewing'
    : pullRequest.mergeable === false
      ? 'resolving_conflict'
      : loaded.requireGreenChecks && pullRequest.requiredChecks.some((check) => check.status !== 'success')
        ? 'waiting_retry'
        : 'ready';
  const source = nextState === 're_reviewing'
    ? await markSourceForRereview(host, sourceId)
    : await updateSourceState(host, sourceId, nextState, undefined);
  return { source, pullRequest };
}

export async function mergeIntegrationSource(
  host: IntegrationOperationHost,
  identity: TaskboardIdentity,
  runId: string,
  sourceId: string,
): Promise<{ source: TaskBoardIntegrationSource; task: ReturnType<typeof rowToTask>; receipt: Record<string, unknown> }> {
  const loaded = await loadOperationContext(host, identity, runId, sourceId);
  if (['needs_human', 'waiting_remediation', 're_reviewing', 'canceled'].includes(loaded.source.state)) {
    throw new TaskboardValidationError('Integration source requires an explicit workflow transition', 'TASKBOARD_SOURCE_NOT_MERGEABLE');
  }
  const provider = requireProvider(host);
  const pullRequest = await provider.getPullRequest(
    loaded.repository,
    loaded.source.providerPullRequestId,
    loaded.boardOwnerUserId,
  );
  if (pullRequest.state === 'merged') {
    if (!pullRequest.mergeCommitOid) {
      throw new TaskboardValidationError('Provider did not return the merged commit oid', 'TASKBOARD_PROVIDER_RECEIPT_INCOMPLETE');
    }
    return finalizeMergedSource(host, sourceId, {
      providerRequestId: `reconcile:${randomUUID()}`,
      mergedCommitOid: pullRequest.mergeCommitOid,
      raw: { reconciled: true, pullRequest },
    });
  }
  if (pullRequest.state !== 'open' || pullRequest.draft) {
    await updateSourceState(host, sourceId, 'needs_human', 'Pull request is not open and mergeable');
    throw new TaskboardValidationError('Pull request is not open for merge', 'TASKBOARD_PR_NOT_OPEN');
  }
  if (pullRequest.subjectDigest !== loaded.source.reviewedSubjectDigest) {
    await markSourceForRereview(host, sourceId);
    throw new TaskboardValidationError('Pull request subject changed and must be reviewed again', 'TASKBOARD_SUBJECT_STALE');
  }
  if (pullRequest.mergeable === false) {
    const exhausted = (loaded.source.remediationCount ?? 0) >= loaded.maxAutomaticRemediationRounds;
    await recordMergeConflict(host, sourceId, exhausted);
    throw new TaskboardValidationError(
      exhausted
        ? 'Automatic remediation rounds exhausted; human intervention is required'
        : 'Pull request conflict requires automatic remediation',
      exhausted ? 'TASKBOARD_REMEDIATION_EXHAUSTED' : 'TASKBOARD_MERGE_CONFLICT',
    );
  }
  if (loaded.requireGreenChecks && pullRequest.requiredChecks.some((check) => check.status !== 'success')) {
    await updateSourceState(host, sourceId, 'waiting_retry', 'Required checks are not green');
    throw new TaskboardValidationError('Required checks are not green', 'TASKBOARD_CHECKS_PENDING');
  }

  const prepared = await prepareOperation(host, loaded, pullRequest);
  if (prepared.state === 'succeeded' || prepared.state === 'reconciled') {
    if (!prepared.mergedCommitOid) {
      throw new TaskboardValidationError('Stored merge operation has no merged commit oid', 'TASKBOARD_PROVIDER_RECEIPT_INCOMPLETE');
    }
    return finalizeMergedSource(host, sourceId, {
      providerRequestId: prepared.providerRequestId ?? prepared.id,
      mergedCommitOid: prepared.mergedCommitOid,
      raw: prepared.providerReceipt ?? { replayed: true },
    });
  }
  if (prepared.state === 'executing' || prepared.state === 'unknown') {
    throw new TaskboardValidationError(
      'Previous merge result is still being reconciled',
      'TASKBOARD_PROVIDER_RESULT_UNKNOWN',
    );
  }
  if (!(await markOperationExecuting(host, prepared.id))) {
    throw new TaskboardValidationError('Merge operation was claimed concurrently', 'TASKBOARD_PROVIDER_RESULT_UNKNOWN');
  }
  try {
    const receipt = await provider.mergePullRequest(
      loaded.repository,
      {
        providerPullRequestId: loaded.source.providerPullRequestId,
        expectedHeadOid: pullRequest.headOid,
        method: loaded.mergeMethod,
        requestId: prepared.providerRequestId ?? prepared.id,
      },
      loaded.boardOwnerUserId,
    );
    if (!receipt.merged || !receipt.mergedCommitOid) {
      await markOperationFailed(host, prepared.id, receipt.message ?? 'Provider refused merge', receipt.raw);
      await recordMergeConflict(
        host,
        sourceId,
        (loaded.source.remediationCount ?? 0) >= loaded.maxAutomaticRemediationRounds,
        receipt.message ?? 'Provider refused merge',
      );
      throw new TaskboardValidationError(receipt.message ?? 'Provider refused merge', 'TASKBOARD_PROVIDER_MERGE_REJECTED');
    }
    return finalizeMergedSource(host, sourceId, {
      providerRequestId: receipt.providerRequestId,
      mergedCommitOid: receipt.mergedCommitOid,
      raw: receipt.raw,
      operationId: prepared.id,
    });
  } catch (error) {
    if (error instanceof TaskboardValidationError) throw error;
    await markOperationUnknown(host, prepared.id, error instanceof Error ? error.message : String(error));
    await updateSourceState(host, sourceId, 'waiting_retry', 'Provider result is unknown; reconciliation required');
    throw new TaskboardValidationError(
      'Merge provider result is unknown and will be reconciled',
      'TASKBOARD_PROVIDER_RESULT_UNKNOWN',
    );
  }
}

export async function linkIntegrationRemediation(
  host: IntegrationOperationHost,
  identity: TaskboardIdentity,
  runId: string,
  sourceId: string,
  remediationTaskId: string,
): Promise<TaskBoardIntegrationSource> {
  return withTransaction(host, async (client) => {
    const result = await client.query(
      `SELECT s.*, i.board_id AS integration_board_id, r.board_id AS remediation_board_id, r.kind AS remediation_kind,
              e.id AS execution_id, e.purpose, e.status AS execution_status, b.tenant_id, b.owner_user_id
         FROM ${host.integrationSourcesTable} s
         JOIN ${host.tasksTable} i ON i.id=s.integration_task_id
         JOIN ${host.tasksTable} r ON r.id=$3
         JOIN ${host.boardsTable} b ON b.id=i.board_id
         JOIN ${host.executionsTable} e ON e.task_id=i.id AND e.run_id=$1
        WHERE s.id=$2 AND b.tenant_id=$4
          AND (b.owner_user_id=$5 OR b.visibility='organization')
        FOR UPDATE OF s`,
      [runId, sourceId, remediationTaskId, identity.tenantId, identity.ownerUserId],
    );
    const row = result.rows[0];
    if (!row) throw new TaskboardNotFoundError('Integration source not found');
    if (row.purpose !== 'merge' || !['queued', 'running', 'waiting_user', 'waiting_approval'].includes(String(row.execution_status))) {
      throw new TaskboardValidationError('Merge execution is not active');
    }
    if (row.integration_board_id !== row.remediation_board_id || row.remediation_kind !== 'remediation') {
      throw new TaskboardValidationError('Remediation task must belong to the same board');
    }
    if (row.state === 'needs_human') {
      throw new TaskboardValidationError('Automatic remediation is exhausted for this source');
    }
    if (!['resolving_conflict', 'waiting_remediation'].includes(String(row.state))) {
      throw new TaskboardValidationError('Integration source is not awaiting remediation');
    }
    if (row.remediation_task_id && row.remediation_task_id !== remediationTaskId) {
      throw new TaskboardValidationError('Integration source already has a remediation task');
    }
    const updated = await client.query(
      `UPDATE ${host.integrationSourcesTable}
          SET remediation_task_id=$2, state='waiting_remediation', last_error=NULL, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [sourceId, remediationTaskId],
    );
    await client.query(
      `INSERT INTO ${host.changesTable}
         (task_id, change_type, actor_type, actor_id, execution_id, payload)
       VALUES ($1,'integration.remediation_linked','agent',$2,$3,$4::jsonb)`,
      [row.integration_task_id, runId, row.execution_id, JSON.stringify({ sourceId, remediationTaskId })],
    );
    return rowToSource(updated.rows[0]!);
  });
}

export async function reconcileUnknownMergeOperations(host: IntegrationOperationHost, limit = 20): Promise<number> {
  const provider = host.repositoryProvider;
  if (!provider) return 0;
  const client = await host.pool.connect();
  let rows: Record<string, unknown>[];
  try {
    const result = await client.query(
      `SELECT o.id, o.integration_source_id, o.updated_at, s.provider_pull_request_id,
              b.repository, b.owner_user_id
         FROM ${host.mergeOperationsTable} o
         JOIN ${host.integrationSourcesTable} s ON s.id=o.integration_source_id
         JOIN ${host.tasksTable} i ON i.id=s.integration_task_id
         JOIN ${host.boardsTable} b ON b.id=i.board_id
        WHERE o.state IN ('executing','unknown')
          AND o.updated_at < now() - interval '30 seconds'
        ORDER BY o.updated_at
        LIMIT $1`,
      [limit],
    );
    rows = result.rows;
  } finally {
    client.release();
  }
  let reconciled = 0;
  for (const row of rows) {
    try {
      const repository = jsonObject(row.repository) as TaskBoardRepositoryConfig | undefined;
      if (!repository) continue;
      const pull = await provider.getPullRequest(
        repository,
        String(row.provider_pull_request_id),
        String(row.owner_user_id),
      );
      if (pull.state === 'open') {
        const unknownForMs = Date.now() - new Date(String(row.updated_at)).getTime();
        if (unknownForMs < 5 * 60_000) continue;
        await markOperationFailed(host, String(row.id), 'Reconciled: merge outcome remained unknown while pull request stayed open', {
          reconciled: true,
          pullRequest: pull,
        });
        await updateSourceState(
          host,
          String(row.integration_source_id),
          'needs_human',
          'Merge outcome remained unknown; inspect the provider before an explicit retry',
        );
        reconciled += 1;
        continue;
      }
      if (pull.state === 'closed') {
        await markOperationFailed(host, String(row.id), 'Reconciled: pull request was closed without merge', {
          reconciled: true,
          pullRequest: pull,
        });
        await updateSourceState(
          host,
          String(row.integration_source_id),
          'needs_human',
          'Pull request was closed without merge',
        );
        reconciled += 1;
        continue;
      }
      if (pull.state !== 'merged' || !pull.mergeCommitOid) continue;
      await finalizeMergedSource(host, String(row.integration_source_id), {
        providerRequestId: `reconcile:${String(row.id)}`,
        mergedCommitOid: pull.mergeCommitOid,
        raw: { reconciled: true, pullRequest: pull },
        operationId: String(row.id),
        reconciled: true,
      });
      reconciled += 1;
    } catch {
      // 下一轮继续；unknown 不能被猜成 failed。
    }
  }
  return reconciled;
}

async function loadOperationContext(
  host: IntegrationOperationHost,
  identity: TaskboardIdentity,
  runId: string,
  sourceId: string,
): Promise<{
  source: TaskBoardIntegrationSource;
  repository: TaskBoardRepositoryConfig;
  boardOwnerUserId: string;
  authorizationId: string;
  mergeMethod: 'merge' | 'squash' | 'rebase';
  requireGreenChecks: boolean;
  maxAutomaticRemediationRounds: number;
  maxTransientRetries: number;
}> {
  const client = await host.pool.connect();
  try {
    const result = await client.query(
      `SELECT s.*, e.purpose, e.status AS execution_status,
              i.id AS integration_task_id_actual, i.status AS integration_status,
              b.tenant_id, b.owner_user_id, b.repository, b.integration_policy,
              l.active_integration_task_id, l.epoch,
              a.id AS authorization_id, a.policy_revision AS authorization_policy_revision,
              a.revoked_at, a.expires_at
         FROM ${host.integrationSourcesTable} s
         JOIN ${host.tasksTable} i ON i.id=s.integration_task_id
         JOIN ${host.boardsTable} b ON b.id=i.board_id
         JOIN ${host.executionsTable} e ON e.task_id=i.id AND e.run_id=$1
         JOIN ${host.integrationLanesTable} l ON l.repository_id=s.repository_id
         JOIN ${host.mergeAuthorizationsTable} a ON a.integration_task_id=i.id
        WHERE s.id=$2 AND b.tenant_id=$3
          AND (b.owner_user_id=$4 OR b.visibility='organization')
        ORDER BY a.created_at DESC
        LIMIT 1`,
      [runId, sourceId, identity.tenantId, identity.ownerUserId],
    );
    const row = result.rows[0];
    if (!row) throw new TaskboardNotFoundError('Integration source execution not found');
    if (row.purpose !== 'merge' || !['queued', 'running', 'waiting_user', 'waiting_approval'].includes(String(row.execution_status))) {
      throw new TaskboardValidationError('Merge execution is not active');
    }
    if (row.active_integration_task_id !== row.integration_task_id_actual) {
      throw new TaskboardValidationError('Integration lane changed', 'TASKBOARD_INTEGRATION_LANE_STALE');
    }
    const repository = jsonObject(row.repository) as TaskBoardRepositoryConfig | undefined;
    const policy = jsonObject(row.integration_policy) as {
      revision?: string;
      execution?: {
        mergeMethod?: string;
        requireGreenChecks?: boolean;
        maxAutomaticRemediationRounds?: number;
        maxTransientRetries?: number;
      };
    } | undefined;
    if (!repository || !policy?.revision || row.authorization_policy_revision !== policy.revision) {
      throw new TaskboardValidationError('Integration policy changed', 'TASKBOARD_POLICY_CHANGED');
    }
    if (row.revoked_at || (row.expires_at && new Date(String(row.expires_at)).getTime() <= Date.now())) {
      throw new TaskboardValidationError('Merge authorization is no longer valid', 'TASKBOARD_MERGE_UNAUTHORIZED');
    }
    const method = policy.execution?.mergeMethod;
    return {
      source: rowToSource(row),
      repository,
      boardOwnerUserId: String(row.owner_user_id),
      authorizationId: String(row.authorization_id),
      mergeMethod: method === 'rebase' || method === 'squash' ? method : 'merge',
      requireGreenChecks: policy.execution?.requireGreenChecks !== false,
      maxAutomaticRemediationRounds: Math.max(0, Number(policy.execution?.maxAutomaticRemediationRounds ?? 3)),
      maxTransientRetries: Math.max(0, Number(policy.execution?.maxTransientRetries ?? 3)),
    };
  } finally {
    client.release();
  }
}

async function prepareOperation(
  host: IntegrationOperationHost,
  loaded: Awaited<ReturnType<typeof loadOperationContext>>,
  pullRequest: RepositoryPullRequestSnapshot,
): Promise<Record<string, any>> {
  return withTransaction(host, async (client) => {
    const source = await client.query(
      `SELECT state, reviewed_subject_digest FROM ${host.integrationSourcesTable} WHERE id=$1 FOR UPDATE`,
      [loaded.source.id],
    );
    if (!source.rows[0]) throw new TaskboardNotFoundError('Integration source not found');
    if (source.rows[0].state === 'merged') {
      const existing = await client.query(
        `SELECT * FROM ${host.mergeOperationsTable} WHERE integration_source_id=$1`,
        [loaded.source.id],
      );
      if (existing.rows[0]) return existing.rows[0];
    }
    if (source.rows[0].reviewed_subject_digest !== pullRequest.subjectDigest) {
      throw new TaskboardValidationError('Reviewed subject changed while preparing merge');
    }
    const existing = await client.query(
      `SELECT * FROM ${host.mergeOperationsTable} WHERE integration_source_id=$1 FOR UPDATE`,
      [loaded.source.id],
    );
    if (existing.rows[0]?.state === 'failed') {
      const requestId = randomUUID();
      const retried = await client.query(
        `UPDATE ${host.mergeOperationsTable}
            SET expected_head_oid=$2, expected_base_oid=$3, reviewed_subject_digest=$4,
                method=$5, state='prepared', provider_request_id=$6,
                provider_receipt=NULL, merged_commit_oid=NULL, error=NULL, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [existing.rows[0].id, pullRequest.headOid, pullRequest.baseOid,
          pullRequest.subjectDigest, loaded.mergeMethod, requestId],
      );
      await client.query(
        `UPDATE ${host.integrationSourcesTable}
            SET state='merging', attempt_count=attempt_count+1, last_error=NULL, updated_at=now()
          WHERE id=$1`,
        [loaded.source.id],
      );
      return retried.rows[0];
    }
    if (existing.rows[0]) return existing.rows[0];
    const operationId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO ${host.mergeOperationsTable}
         (id, integration_source_id, authorization_id, repository_id, provider_pull_request_id,
          expected_head_oid, expected_base_oid, reviewed_subject_digest, method, state, provider_request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'prepared',$10)
       RETURNING *`,
      [
        operationId, loaded.source.id, loaded.authorizationId, loaded.repository.repositoryId,
        loaded.source.providerPullRequestId, pullRequest.headOid, pullRequest.baseOid,
        pullRequest.subjectDigest, loaded.mergeMethod, operationId,
      ],
    );
    await client.query(
      `UPDATE ${host.integrationSourcesTable}
          SET state='merging', attempt_count=attempt_count+1, last_error=NULL, updated_at=now()
        WHERE id=$1`,
      [loaded.source.id],
    );
    return inserted.rows[0];
  });
}

async function markOperationExecuting(host: IntegrationOperationHost, operationId: string): Promise<boolean> {
  return withTransaction(host, async (client) => {
    const result = await client.query(
      `UPDATE ${host.mergeOperationsTable} SET state='executing', updated_at=now()
        WHERE id=$1 AND state='prepared'
        RETURNING id`,
      [operationId],
    );
    return Boolean(result.rows[0]);
  });
}

async function markOperationFailed(
  host: IntegrationOperationHost,
  operationId: string,
  error: string,
  receipt: Record<string, unknown>,
): Promise<void> {
  await withTransaction(host, async (client) => {
    await client.query(
      `UPDATE ${host.mergeOperationsTable}
          SET state='failed', error=$2, provider_receipt=$3::jsonb, updated_at=now()
        WHERE id=$1 AND state IN ('prepared','executing','unknown')`,
      [operationId, error, JSON.stringify(receipt)],
    );
  });
}

async function markOperationUnknown(host: IntegrationOperationHost, operationId: string, error: string): Promise<void> {
  await withTransaction(host, async (client) => {
    await client.query(
      `UPDATE ${host.mergeOperationsTable}
          SET state='unknown', error=$2, updated_at=now()
        WHERE id=$1 AND state='executing'`,
      [operationId, error],
    );
  });
}

async function finalizeMergedSource(
  host: IntegrationOperationHost,
  sourceId: string,
  input: {
    providerRequestId: string;
    mergedCommitOid: string;
    raw: Record<string, unknown>;
    operationId?: string;
    reconciled?: boolean;
  },
): Promise<{ source: TaskBoardIntegrationSource; task: ReturnType<typeof rowToTask>; receipt: Record<string, unknown> }> {
  return withTransaction(host, async (client) => {
    const sourceResult = await client.query(
      `SELECT * FROM ${host.integrationSourcesTable} WHERE id=$1 FOR UPDATE`,
      [sourceId],
    );
    const sourceRow = sourceResult.rows[0];
    if (!sourceRow) throw new TaskboardNotFoundError('Integration source not found');
    const receiptId = input.providerRequestId;
    await client.query(
      `UPDATE ${host.integrationSourcesTable}
          SET state='merged', provider_receipt_id=$2, merged_commit_oid=$3,
              last_error=NULL, updated_at=now()
        WHERE id=$1`,
      [sourceId, receiptId, input.mergedCommitOid],
    );
    if (input.operationId) {
      await client.query(
        `UPDATE ${host.mergeOperationsTable}
            SET state=$5, provider_request_id=$2, provider_receipt=$3::jsonb,
                merged_commit_oid=$4, error=NULL, updated_at=now()
          WHERE id=$1 AND state IN ('executing','unknown')`,
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
          SET status='done', merged_commit_oid=$2, completed_at=now(),
              version=version+1, updated_at=now()
        WHERE id=$1`,
      [sourceRow.delivery_task_id, input.mergedCommitOid],
    );
    await client.query(
      `INSERT INTO ${host.changesTable}
         (task_id, change_type, actor_type, actor_id, payload)
       VALUES ($1,'merge.succeeded','system',$2,$3::jsonb)`,
      [sourceRow.delivery_task_id, input.providerRequestId, JSON.stringify({
        integrationTaskId: sourceRow.integration_task_id,
        sourceId,
        mergedCommitOid: input.mergedCommitOid,
        providerRequestId: input.providerRequestId,
      })],
    );
    const taskResult = await client.query(
      `SELECT t.*,
              (SELECT count(*)::int FROM ${host.commentsTable} c WHERE c.task_id=t.id) AS comment_count
         FROM ${host.tasksTable} t WHERE t.id=$1`,
      [sourceRow.delivery_task_id],
    );
    const updatedSource = await client.query(`SELECT * FROM ${host.integrationSourcesTable} WHERE id=$1`, [sourceId]);
    return {
      source: rowToSource(updatedSource.rows[0]!),
      task: rowToTask(taskResult.rows[0]!),
      receipt: input.raw,
    };
  });
}

async function recordMergeConflict(
  host: IntegrationOperationHost,
  sourceId: string,
  exhausted: boolean,
  error = 'Pull request has merge conflicts',
): Promise<void> {
  await withTransaction(host, async (client) => {
    await client.query(
      `UPDATE ${host.integrationSourcesTable}
          SET state=$2, remediation_count=remediation_count+1,
              remediation_task_id=NULL, last_error=$3, updated_at=now()
        WHERE id=$1`,
      [sourceId, exhausted ? 'needs_human' : 'resolving_conflict', error],
    );
  });
}

async function markSourceForRereview(
  host: IntegrationOperationHost,
  sourceId: string,
): Promise<TaskBoardIntegrationSource> {
  return withTransaction(host, async (client) => {
    const result = await client.query(
      `UPDATE ${host.integrationSourcesTable}
          SET state='re_reviewing', last_error='Pull request subject changed after review', updated_at=now()
        WHERE id=$1
        RETURNING *`,
      [sourceId],
    );
    const row = result.rows[0];
    if (!row) throw new TaskboardNotFoundError('Integration source not found');
    await client.query(
      `UPDATE ${host.tasksTable}
          SET status='in_review', reviewed_subject_digest=NULL,
              version=version+1, updated_at=now()
        WHERE id=$1 AND status IN ('ready_to_merge','done')`,
      [row.delivery_task_id],
    );
    await client.query(
      `INSERT INTO ${host.changesTable}
         (task_id, change_type, actor_type, actor_id, payload)
       VALUES ($1,'review.subject_stale','system',$2,$3::jsonb)`,
      [row.delivery_task_id, sourceId, JSON.stringify({ sourceId, integrationTaskId: row.integration_task_id })],
    );
    return rowToSource(row);
  });
}

async function updateSourceState(
  host: IntegrationOperationHost,
  sourceId: string,
  state: TaskBoardIntegrationSource['state'],
  error?: string,
): Promise<TaskBoardIntegrationSource> {
  return withTransaction(host, async (client) => {
    const result = await client.query(
      `UPDATE ${host.integrationSourcesTable}
          SET state=$2, last_error=$3, updated_at=now()
        WHERE id=$1
        RETURNING *`,
      [sourceId, state, error ?? null],
    );
    if (!result.rows[0]) throw new TaskboardNotFoundError('Integration source not found');
    return rowToSource(result.rows[0]);
  });
}

function rowToSource(row: Record<string, unknown>): TaskBoardIntegrationSource {
  return {
    id: String(row.id),
    integrationTaskId: String(row.integration_task_id),
    deliveryTaskId: String(row.delivery_task_id),
    repositoryId: String(row.repository_id),
    providerPullRequestId: String(row.provider_pull_request_id),
    reviewedSubjectDigest: String(row.reviewed_subject_digest),
    order: Number(row.source_order),
    state: String(row.state) as TaskBoardIntegrationSource['state'],
    attemptCount: Number(row.attempt_count),
    remediationCount: Number(row.remediation_count ?? 0),
    ...(row.provider_receipt_id ? { providerReceiptId: String(row.provider_receipt_id) } : {}),
    ...(row.merged_commit_oid ? { mergedCommitOid: String(row.merged_commit_oid) } : {}),
    ...(row.remediation_task_id ? { remediationTaskId: String(row.remediation_task_id) } : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    updatedAt: toIso(row.updated_at),
  };
}

function requireProvider(host: IntegrationOperationHost): RepositoryProvider {
  if (!host.repositoryProvider) {
    throw new TaskboardValidationError('Repository provider is unavailable', 'TASKBOARD_REPOSITORY_PROVIDER_UNAVAILABLE');
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

async function withTransaction<T>(
  host: IntegrationOperationHost,
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
