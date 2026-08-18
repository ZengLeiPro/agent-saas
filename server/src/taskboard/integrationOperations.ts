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
import { rowToTask, toIso, visibleCommentPredicate } from './storeHelpers.js';
import {
  completeRemediationAfterMerge,
  fenceTaskExecutions,
} from './workflow/commandService.js';
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
  blockEpisodesTable: string;
  remediationAttemptsTable: string;
  resolutionsTable: string;
  cancellationOutboxTable: string;
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
  if (['merged', 'needs_human', 'resolving_conflict', 'waiting_remediation'].includes(loaded.source.state)) {
    return { source: loaded.source, pullRequest };
  }
  const failedChecks = loaded.requireGreenChecks
    && pullRequest.requiredChecks.some((check) => check.status === 'failure');
  const nextState = pullRequest.subjectDigest !== loaded.source.reviewedSubjectDigest
    ? 're_reviewing'
    : pullRequest.mergeable === false || failedChecks
      ? (loaded.source.remediationCount ?? 0) >= loaded.maxAutomaticRemediationRounds
        ? 'needs_human'
        : 'resolving_conflict'
      : loaded.requireGreenChecks && pullRequest.requiredChecks.some((check) => check.status !== 'success')
        ? 'waiting_retry'
        : 'ready';
  const source = nextState === 're_reviewing'
    ? await markSourceForRereview(host, sourceId)
    : await updateSourceState(
      host,
      sourceId,
      nextState,
      failedChecks ? 'Required checks failed; automatic remediation is required' : undefined,
    );
  return { source, pullRequest };
}

export async function mergeIntegrationSource(
  host: IntegrationOperationHost,
  identity: TaskboardIdentity,
  runId: string,
  sourceId: string,
): Promise<{ source: TaskBoardIntegrationSource; task: ReturnType<typeof rowToTask>; receipt: Record<string, unknown> }> {
  const loaded = await loadOperationContext(host, identity, runId, sourceId);
  if (['needs_human', 'waiting_remediation', 'resolving_conflict', 're_reviewing', 'canceled'].includes(loaded.source.state)) {
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
      exceptExecutionId: loaded.executionId,
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
    await recordMergeConflict(host, sourceId, exhausted, 'Pull request has merge conflicts');
    throw new TaskboardValidationError(
      exhausted
        ? 'Automatic remediation rounds exhausted; human intervention is required'
        : 'Pull request conflict requires automatic remediation',
      exhausted ? 'TASKBOARD_REMEDIATION_EXHAUSTED' : 'TASKBOARD_MERGE_CONFLICT',
    );
  }
  if (loaded.requireGreenChecks && pullRequest.requiredChecks.some((check) => check.status === 'failure')) {
    const exhausted = (loaded.source.remediationCount ?? 0) >= loaded.maxAutomaticRemediationRounds;
    await recordMergeConflict(host, sourceId, exhausted, 'Required checks failed; automatic remediation is required');
    throw new TaskboardValidationError(
      exhausted
        ? 'Automatic remediation rounds exhausted; human intervention is required'
        : 'Required checks failed and require automatic remediation',
      exhausted ? 'TASKBOARD_REMEDIATION_EXHAUSTED' : 'TASKBOARD_CHECKS_FAILED',
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
      exceptExecutionId: loaded.executionId,
    });
  }
  if (prepared.state === 'executing' || prepared.state === 'unknown') {
    throw new TaskboardValidationError(
      'Previous merge result is still being reconciled',
      'TASKBOARD_PROVIDER_RESULT_UNKNOWN',
    );
  }
  if (!(await markOperationExecuting(host, prepared.id, runId, loaded))) {
    throw new TaskboardValidationError(
      'Merge authorization changed before the provider side effect',
      'TASKBOARD_PROVIDER_GUARD_STALE',
    );
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
      exceptExecutionId: loaded.executionId,
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
    const preview = await client.query(
      `SELECT integration_task_id,delivery_task_id FROM ${host.integrationSourcesTable} WHERE id=$1`,
      [sourceId],
    );
    if (!preview.rows[0]) throw new TaskboardNotFoundError('Integration source not found');
    const taskIds = [...new Set([
      String(preview.rows[0].integration_task_id),
      String(preview.rows[0].delivery_task_id),
      remediationTaskId,
    ])].sort();
    // Global lock order: Task(s) -> Source -> Execution/Attempt.
    await client.query(
      `SELECT id FROM ${host.tasksTable} WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`,
      [taskIds],
    );
    const sourceResult = await client.query(
      `SELECT s.*, i.board_id AS integration_board_id, r.board_id AS remediation_board_id,
              r.kind AS remediation_kind,r.status AS remediation_status,
              d.branch AS delivery_branch,d.pull_request_number AS delivery_pull_request_number,
              d.head_oid AS delivery_head_oid,d.base_oid AS delivery_base_oid,
              b.tenant_id,b.owner_user_id
         FROM ${host.integrationSourcesTable} s
         JOIN ${host.tasksTable} i ON i.id=s.integration_task_id
         JOIN ${host.tasksTable} d ON d.id=s.delivery_task_id
         JOIN ${host.tasksTable} r ON r.id=$2
         JOIN ${host.boardsTable} b ON b.id=i.board_id
        WHERE s.id=$1 AND b.tenant_id=$3
          AND (b.owner_user_id=$4 OR b.visibility='organization')
        FOR UPDATE OF s`,
      [sourceId, remediationTaskId, identity.tenantId, identity.ownerUserId],
    );
    const sourceRow = sourceResult.rows[0];
    if (!sourceRow) throw new TaskboardNotFoundError('Integration source not found');
    const executionResult = await client.query(
      `SELECT id AS execution_id,purpose,status AS execution_status,resolved_at,superseded_at
         FROM ${host.executionsTable}
        WHERE task_id=$1 AND run_id=$2
        FOR UPDATE`,
      [sourceRow.integration_task_id, runId],
    );
    const row = executionResult.rows[0] ? { ...sourceRow, ...executionResult.rows[0] } : undefined;
    if (!row) throw new TaskboardNotFoundError('Integration source execution not found');
    if (row.purpose !== 'merge' || row.resolved_at || row.superseded_at
      || !['queued', 'running', 'waiting_user', 'waiting_approval'].includes(String(row.execution_status))) {
      throw new TaskboardValidationError('Merge execution is not active');
    }
    if (row.integration_board_id !== row.remediation_board_id || row.remediation_kind !== 'remediation') {
      throw new TaskboardValidationError('Remediation task must belong to the same board');
    }
    if (['done', 'canceled'].includes(String(row.remediation_status))) {
      throw new TaskboardValidationError(
        'Terminal remediation task cannot be linked',
        'TASKBOARD_REMEDIATION_TERMINAL',
      );
    }
    if (row.state === 'needs_human') {
      throw new TaskboardValidationError('Automatic remediation is exhausted for this source');
    }
    if (!['resolving_conflict', 'waiting_remediation', 'waiting_retry'].includes(String(row.state))) {
      throw new TaskboardValidationError('Integration source is not awaiting remediation');
    }
    if (row.remediation_task_id && row.remediation_task_id !== remediationTaskId) {
      throw new TaskboardValidationError(
        'Integration source already has a different remediation task',
        'TASKBOARD_REMEDIATION_LINK_CONFLICT',
      );
    }
    const round = Math.max(1, Number(row.remediation_count ?? 0) + 1);
    const attemptId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO ${host.remediationAttemptsTable}
         (id,integration_source_id,round,remediation_task_id,state,base_head_oid)
       VALUES ($1,$2,$3,$4,'active',$5)
       ON CONFLICT DO NOTHING
       RETURNING id,integration_source_id,round,remediation_task_id`,
      [attemptId, sourceId, round, remediationTaskId, row.delivery_head_oid ?? null],
    );
    let canonical = inserted.rows[0];
    if (!canonical) {
      const existing = await client.query(
        `SELECT id,integration_source_id,round,remediation_task_id
           FROM ${host.remediationAttemptsTable}
          WHERE remediation_task_id=$1 OR (integration_source_id=$2 AND round=$3)
          ORDER BY CASE WHEN remediation_task_id=$1 THEN 0 ELSE 1 END
          FOR UPDATE`,
        [remediationTaskId, sourceId, round],
      );
      canonical = existing.rows.find((attempt) => String(attempt.remediation_task_id) === remediationTaskId
        && String(attempt.integration_source_id) === sourceId && Number(attempt.round) === round);
      if (!canonical || existing.rows.some((attempt) => String(attempt.id) !== String(canonical.id))) {
        throw new TaskboardValidationError(
          'Remediation attempt conflicts with its source, round, or task identity',
          'TASKBOARD_REMEDIATION_LINK_CONFLICT',
        );
      }
    }
    await client.query(
      `UPDATE ${host.tasksTable}
          SET branch=COALESCE($2,branch), provider_pull_request_id=$3,
              pull_request_number=COALESCE($4,pull_request_number),
              head_oid=COALESCE($5,head_oid), base_oid=COALESCE($6,base_oid),
              version=version+1, updated_at=now()
        WHERE id=$1 AND kind='remediation' AND status='todo'
          AND (
            ($2::text IS NOT NULL AND branch IS DISTINCT FROM $2)
            OR provider_pull_request_id IS DISTINCT FROM $3
            OR ($4::integer IS NOT NULL AND pull_request_number IS DISTINCT FROM $4)
            OR ($5::text IS NOT NULL AND head_oid IS DISTINCT FROM $5)
            OR ($6::text IS NOT NULL AND base_oid IS DISTINCT FROM $6)
          )`,
      [remediationTaskId, row.delivery_branch ?? null, String(row.provider_pull_request_id),
        row.delivery_pull_request_number ?? null, row.delivery_head_oid ?? null, row.delivery_base_oid ?? null],
    );
    const updated = await client.query(
      `UPDATE ${host.integrationSourcesTable}
          SET remediation_task_id=$2, state='waiting_remediation', last_error=NULL, updated_at=now()
        WHERE id=$1 AND (remediation_task_id IS NULL OR remediation_task_id=$2)
        RETURNING *`,
      [sourceId, remediationTaskId],
    );
    if (!updated.rows[0]) {
      throw new TaskboardValidationError(
        'Integration source remediation pointer changed concurrently',
        'TASKBOARD_REMEDIATION_LINK_CONFLICT',
      );
    }
    if (inserted.rows[0]) {
      await client.query(
        `INSERT INTO ${host.changesTable}
           (task_id, change_type, actor_type, actor_id, execution_id, payload)
         VALUES ($1,'integration.remediation_linked','agent',$2,$3,$4::jsonb)`,
        [row.integration_task_id, runId, row.execution_id, JSON.stringify({
          sourceId, remediationTaskId, attemptId: String(canonical.id), round,
        })],
      );
    }
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
  executionId: string;
  repository: TaskBoardRepositoryConfig;
  boardOwnerUserId: string;
  authorizationId: string;
  mergeMethod: 'merge' | 'squash' | 'rebase';
  requireGreenChecks: boolean;
  maxAutomaticRemediationRounds: number;
  maxTransientRetries: number;
  laneEpoch: string;
}> {
  const client = await host.pool.connect();
  try {
    const result = await client.query(
      `SELECT s.*, e.id AS execution_id,e.purpose,e.status AS execution_status,
              e.resolved_at,e.superseded_at,
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
    if (row.purpose !== 'merge' || row.resolved_at || row.superseded_at
      || !['queued', 'running', 'waiting_user', 'waiting_approval'].includes(String(row.execution_status))) {
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
      executionId: String(row.execution_id),
      repository,
      boardOwnerUserId: String(row.owner_user_id),
      authorizationId: String(row.authorization_id),
      mergeMethod: method === 'rebase' || method === 'squash' ? method : 'merge',
      requireGreenChecks: policy.execution?.requireGreenChecks !== false,
      maxAutomaticRemediationRounds: Math.max(0, Number(policy.execution?.maxAutomaticRemediationRounds ?? 3)),
      maxTransientRetries: Math.max(0, Number(policy.execution?.maxTransientRetries ?? 3)),
      laneEpoch: String(row.epoch),
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
      `SELECT state, reviewed_subject_digest, merged_commit_oid, provider_receipt_id
         FROM ${host.integrationSourcesTable} WHERE id=$1 FOR UPDATE`,
      [loaded.source.id],
    );
    if (!source.rows[0]) throw new TaskboardNotFoundError('Integration source not found');
    if (source.rows[0].state === 'merged' || source.rows[0].merged_commit_oid || source.rows[0].provider_receipt_id) {
      const existing = await client.query(
        `SELECT * FROM ${host.mergeOperationsTable} WHERE integration_source_id=$1`,
        [loaded.source.id],
      );
      if (existing.rows[0]) return existing.rows[0];
      throw new TaskboardValidationError(
        'Integration source already has a merge fact and requires reconciliation',
        'TASKBOARD_PROVIDER_RESULT_UNKNOWN',
      );
    }
    if (['needs_human', 'waiting_remediation', 're_reviewing', 'canceled'].includes(String(source.rows[0].state))) {
      throw new TaskboardValidationError(
        'Integration source changed before merge preparation',
        'TASKBOARD_PROVIDER_GUARD_STALE',
      );
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

async function markOperationExecuting(
  host: IntegrationOperationHost,
  operationId: string,
  runId: string,
  loaded: Awaited<ReturnType<typeof loadOperationContext>>,
): Promise<boolean> {
  return withTransaction(host, async (client) => {
    const preview = await client.query(
      `SELECT s.integration_task_id
         FROM ${host.mergeOperationsTable} o
         JOIN ${host.integrationSourcesTable} s ON s.id=o.integration_source_id
        WHERE o.id=$1`,
      [operationId],
    );
    if (!preview.rows[0]) return false;
    // Last authoritative guard before the irreversible provider call. Lock in Task -> Source -> Operation order.
    await client.query(
      `SELECT id FROM ${host.tasksTable} WHERE id=$1 FOR UPDATE`,
      [preview.rows[0].integration_task_id],
    );
    const source = await client.query(
      `SELECT id,state,integration_task_id,repository_id,merged_commit_oid,provider_receipt_id
         FROM ${host.integrationSourcesTable} WHERE id=$1 FOR UPDATE`,
      [loaded.source.id],
    );
    if (!source.rows[0] || source.rows[0].state !== 'merging'
      || source.rows[0].merged_commit_oid || source.rows[0].provider_receipt_id
      || String(source.rows[0].integration_task_id) !== loaded.source.integrationTaskId
      || String(source.rows[0].repository_id) !== loaded.repository.repositoryId) return false;
    const result = await client.query(
      `UPDATE ${host.mergeOperationsTable} o
          SET state='executing', updated_at=now()
         FROM ${host.executionsTable} e,
              ${host.tasksTable} i,
              ${host.boardsTable} b,
              ${host.mergeAuthorizationsTable} a,
              ${host.integrationLanesTable} l
        WHERE o.id=$1 AND o.integration_source_id=$2 AND o.authorization_id=$3
          AND o.state='prepared'
          AND e.id=$4 AND e.run_id=$5 AND e.task_id=i.id AND e.purpose='merge'
          AND e.status IN ('queued','running','waiting_user','waiting_approval')
          AND e.resolved_at IS NULL AND e.superseded_at IS NULL
          AND i.id=$6 AND i.status IN ('todo','in_progress') AND i.board_id=b.id
          AND a.id=$3 AND a.integration_task_id=i.id AND a.repository_id=$7
          AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp())
          AND a.policy_revision=b.integration_policy->>'revision'
          AND l.repository_id=$7 AND l.active_integration_task_id=i.id AND l.epoch=$8::bigint
        RETURNING o.id`,
      [operationId, loaded.source.id, loaded.authorizationId, loaded.executionId, runId,
        loaded.source.integrationTaskId, loaded.repository.repositoryId, loaded.laneEpoch],
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
    exceptExecutionId?: string;
  },
): Promise<{ source: TaskBoardIntegrationSource; task: ReturnType<typeof rowToTask>; receipt: Record<string, unknown> }> {
  return withTransaction(host, async (client) => {
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
          SET state=$2, remediation_task_id=NULL, last_error=$3, updated_at=now()
        WHERE id=$1 AND state<>'merged'
          AND merged_commit_oid IS NULL AND provider_receipt_id IS NULL`,
      [sourceId, exhausted ? 'needs_human' : 'resolving_conflict', error],
    );
  });
}

async function markSourceForRereview(
  host: IntegrationOperationHost,
  sourceId: string,
): Promise<TaskBoardIntegrationSource> {
  return withTransaction(host, async (client) => {
    const preview = await client.query(
      `SELECT delivery_task_id FROM ${host.integrationSourcesTable} WHERE id=$1`,
      [sourceId],
    );
    if (!preview.rows[0]) throw new TaskboardNotFoundError('Integration source not found');
    // Global lock order: Task -> Source. This matches merge finalization and avoids TASK-69 deadlocks.
    await client.query(
      `SELECT id FROM ${host.tasksTable} WHERE id=$1 FOR UPDATE`,
      [preview.rows[0].delivery_task_id],
    );
    const result = await client.query(
      `UPDATE ${host.integrationSourcesTable}
          SET state='re_reviewing', last_error='Pull request subject changed after review', updated_at=now()
        WHERE id=$1 AND state<>'merged'
          AND merged_commit_oid IS NULL AND provider_receipt_id IS NULL
        RETURNING *`,
      [sourceId],
    );
    let row = result.rows[0];
    if (!row) {
      const current = await client.query(
        `SELECT * FROM ${host.integrationSourcesTable} WHERE id=$1`,
        [sourceId],
      );
      row = current.rows[0];
      if (!row) throw new TaskboardNotFoundError('Integration source not found');
      return rowToSource(row);
    }
    await client.query(
      `UPDATE ${host.tasksTable}
          SET status='in_review', reviewed_subject_digest=NULL,
              version=version+1, updated_at=now()
        WHERE id=$1 AND status='ready_to_merge' AND merged_commit_oid IS NULL`,
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
        WHERE id=$1 AND state<>'merged'
          AND merged_commit_oid IS NULL AND provider_receipt_id IS NULL
        RETURNING *`,
      [sourceId, state, error ?? null],
    );
    if (result.rows[0]) return rowToSource(result.rows[0]);
    const current = await client.query(
      `SELECT * FROM ${host.integrationSourcesTable} WHERE id=$1`,
      [sourceId],
    );
    if (!current.rows[0]) throw new TaskboardNotFoundError('Integration source not found');
    return rowToSource(current.rows[0]);
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
