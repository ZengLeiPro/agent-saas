import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';

import {
  TASKBOARD_DEFAULT_PROMPT,
  type TaskBoard,
  type TaskBoardComment,
  type TaskBoardCommentCreateInput,
  type TaskBoardCommentPatchInput,
  type TaskBoardCreateInput,
  type TaskBoardExecution,
  type TaskBoardExecutionContextInput,
  type TaskBoardExecutionContextResponse,
  type TaskBoardExecutionResolutionInput,
  type TaskBoardExecutionStartResult,
  type TaskBoardIntegrationBatchCreateInput,
  type TaskBoardIntegrationSource,
  type TaskBoardMember,
  type TaskBoardMemberPatchInput,
  type TaskBoardPatchInput, type TaskBoardRepositoryConfig,
  type TaskBoardTask,
  type TaskBoardTaskCreateInput,
  type TaskBoardTaskMoveInput,
  type TaskBoardTaskPatchInput,
} from '../../../shared/src/types/taskboard.js';
import {
  completeContinuation,
  listTaskExecutions,
  loadContinuationContext,
  loadExecutionContext,
  loadExecutionModelContext,
  markContinuationRunning,
  nextTaskColumnSortOrder,
} from './continuationStore.js';
import {
  claimContinuationDispatch,
  claimContinuationReconcileCandidates,
  enqueueContinuation,
  finishContinuation,
  markContinuationDispatchSucceeded,
  releaseContinuationReconcile,
  retryContinuationDispatch,
} from './continuationOutbox.js';
import {
  claimExecutionDispatch,
  claimExecutionReconcileCandidates,
  markExecutionDispatchSucceeded,
  retryExecutionDispatch,
} from './executionOutboxStore.js';
import {
  createTaskFromExecution as createStoredTaskFromExecution,
  updateTaskBranchFromExecution as updateStoredTaskBranchFromExecution,
} from './executionTaskActions.js';
import { moveTaskFromReviewExecution } from './executionTaskMove.js';
import {
  allowedActionsForRole, boardRepositoryFragment,
  normalizeBoardPrompt,
  normalizeModel,
  normalizeRepositoryConfig,
  rowToBoard,
} from './boardFields.js';
import type { RepositoryProvider } from './repositoryProvider.js';
import { claimIntegrationDispatchCandidates } from './integrationTriggers.js';
import { attachExecutionPullRequest, recordReviewedExecutionSubject } from './deliveryPullRequests.js';
import {
  inspectIntegrationSource,
  linkIntegrationRemediation,
  mergeIntegrationSource,
  reconcileUnknownMergeOperations,
  type IntegrationSourceInspection,
} from './integrationOperations.js';
import {
  appendBoardChange,
  appendTaskChange,
  cancelIntegrationTask as cancelStoredIntegrationTask,
  createExecutionCommentV2 as createStoredExecutionCommentV2,
  createIntegrationBatch as createStoredIntegrationBatch,
  getExecutionContextV2 as getStoredExecutionContextV2,
  listBoardMembers as listStoredBoardMembers,
  listIntegrationSources as listStoredIntegrationSources,
  removeBoardMember as removeStoredBoardMember,
  resolveExecutionV2 as resolveStoredExecutionV2,
  upsertBoardMember as upsertStoredBoardMember,
} from './v2Store.js';
import {
  assertActiveBoard,
  assertExpectedVersion,
  assertWritableTask,
  applyCommentAuthorDisplayName,
  mapActiveBoardNameError,
  normalizeAttachments,
  normalizeLabels,
  optionalText,
  requireText,
  rowToComment,
  rowToTask,
  sanitizeIdentifier,
  toIso,
  validateMoveNeighbors,
} from './storeHelpers.js';
import { assertBoardHasNoActiveRuns, assertTaskHasNoActiveRuns } from './archiveGuard.js';
import { deleteComment as deleteStoredComment, updateComment as updateStoredComment } from './storeComments.js';
import {
  getExecutionContextBySessionId as getStoredExecutionContextBySessionId,
  searchExecutions as searchStoredExecutions,
} from './storeExecutions.js';
import {
  listBoards as listStoredBoards,
  listTasks as listStoredTasks,
  searchBoards as searchStoredBoards,
  searchComments as searchStoredComments,
  searchTasks as searchStoredTasks,
} from './storeSearch.js';
import { initializeTaskboardStore } from './storeSchema.js';
import {
  claimExecution as claimStoredExecution,
  completeExecution as completeStoredExecution,
  completeExecutionFromReconcile as completeStoredExecutionFromReconcile,
  setExecutionStatus as setStoredExecutionStatus,
  setExecutionStatusFromReconcile as setStoredExecutionStatusFromReconcile,
} from './storeExecutionLifecycle.js';
import {
  TaskboardNotFoundError,
  TaskboardPermissionError,
  TaskboardValidationError,
  type TaskboardBoardSearchFilter,
  type TaskboardContinuationContext,
  type TaskboardContinuationDispatch,
  type TaskboardContinuationDispatchPayload,
  type TaskboardContinuationReconcileCandidate,
  type TaskboardExecutionClaimInput,
  type TaskboardExecutionCompletionInput,
  type TaskboardExecutionContext,
  type TaskboardExecutionModelContext,
  type TaskboardExecutionStore,
  type TaskboardExpectedVersionInput,
  type TaskboardIdentity,
  type TaskboardPage,
  type TaskboardPageFilter,
  type TaskboardService,
  type TaskboardTaskListFilter,
  type TaskboardTaskSearchFilter,
} from './types.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

const DEFAULT_SORT_GAP = 1024;
const MIN_SORT_GAP = 1e-7;
export { TASKBOARD_TABLE_PREFIX_MAX_LENGTH } from './storeHelpers.js';

export interface PgTaskboardStoreOptions {
  pool: PgPool;
  tablePrefix?: string;
  repositoryProvider?: RepositoryProvider;
}

export class PgTaskboardStore implements TaskboardService, TaskboardExecutionStore {
  readonly pool: PgPool;
  readonly boardsTable: string;
  readonly tasksTable: string;
  readonly commentsTable: string;
  readonly executionsTable: string;
  readonly executionOutboxTable: string;
  readonly continuationOutboxTable: string;
  readonly membersTable: string;
  readonly changesTable: string;
  readonly attemptsTable: string;
  readonly integrationLanesTable: string;
  readonly integrationSourcesTable: string;
  readonly mergeAuthorizationsTable: string;
  readonly mergeOperationsTable: string;
  readonly blockEpisodesTable: string;
  readonly integrationTriggerOutboxTable: string;
  repositoryProvider?: RepositoryProvider;

  constructor(options: PgTaskboardStoreOptions) {
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.pool = options.pool;
    this.repositoryProvider = options.repositoryProvider;
    this.boardsTable = `${prefix}_taskboards`;
    this.tasksTable = `${prefix}_taskboard_tasks`;
    this.commentsTable = `${prefix}_taskboard_comments`;
    this.executionsTable = `${prefix}_taskboard_execs`;
    this.executionOutboxTable = `${prefix}_taskboard_exec_outbox`;
    this.continuationOutboxTable = `${prefix}_taskboard_cont_outbox`;
    this.membersTable = `${prefix}_taskboard_members`;
    this.changesTable = `${prefix}_taskboard_changes`;
    this.attemptsTable = `${prefix}_taskboard_attempts`;
    this.integrationLanesTable = `${prefix}_taskboard_integration_lanes`;
    this.integrationSourcesTable = `${prefix}_taskboard_integration_sources`;
    this.mergeAuthorizationsTable = `${prefix}_taskboard_merge_auths`;
    this.mergeOperationsTable = `${prefix}_taskboard_merge_ops`;
    this.blockEpisodesTable = `${prefix}_taskboard_block_episodes`;
    this.integrationTriggerOutboxTable = `${prefix}_taskboard_integration_outbox`;
  }

  async init(): Promise<void> {
    await initializeTaskboardStore(this);
  }
  listMembers(identity: TaskboardIdentity, boardId: string): Promise<TaskBoardMember[]> {
    return listStoredBoardMembers(this, identity, boardId);
  }

  upsertMember(
    identity: TaskboardIdentity,
    boardId: string,
    input: TaskBoardMemberPatchInput,
  ): Promise<TaskBoardMember> {
    return upsertStoredBoardMember(this, identity, boardId, input);
  }

  removeMember(identity: TaskboardIdentity, boardId: string, userId: string): Promise<void> {
    return removeStoredBoardMember(this, identity, boardId, userId);
  }

  createIntegrationBatch(
    identity: TaskboardIdentity,
    boardId: string,
    input: TaskBoardIntegrationBatchCreateInput,
    source: 'scheduled_policy' | 'on_ready_policy' | 'manual_batch' = 'manual_batch',
  ): Promise<TaskBoardTask> {
    return createStoredIntegrationBatch(this, identity, boardId, input, source);
  }

  cancelIntegrationTask(
    identity: TaskboardIdentity,
    taskId: string,
    input: { expectedVersion: number; reason?: string },
  ): Promise<TaskBoardTask> {
    return cancelStoredIntegrationTask(this, identity, taskId, input);
  }

  listIntegrationSources(
    identity: TaskboardIdentity,
    integrationTaskId: string,
  ): Promise<TaskBoardIntegrationSource[]> {
    return listStoredIntegrationSources(this, identity, integrationTaskId);
  }

  getExecutionContextV2(
    identity: TaskboardIdentity,
    taskId: string,
    input?: TaskBoardExecutionContextInput,
  ): Promise<TaskBoardExecutionContextResponse> {
    return getStoredExecutionContextV2(this, identity, taskId, input);
  }

  createExecutionCommentV2(
    identity: TaskboardIdentity,
    runId: string,
    body: string,
  ): Promise<TaskBoardComment> {
    return createStoredExecutionCommentV2(this, identity, runId, body);
  }

  setRepositoryProvider(provider: RepositoryProvider): void {
    this.repositoryProvider = provider;
  }

  attachExecutionPullRequestV2(
    identity: TaskboardIdentity,
    runId: string,
    providerPullRequestId: string,
  ): Promise<TaskBoardTask> {
    return attachExecutionPullRequest(this, identity, runId, providerPullRequestId);
  }

  recordReviewedExecutionSubjectV2(
    identity: TaskboardIdentity,
    runId: string,
  ): Promise<TaskBoardTask> {
    return recordReviewedExecutionSubject(this, identity, runId);
  }

  inspectIntegrationSourceV2(
    identity: TaskboardIdentity,
    runId: string,
    sourceId: string,
  ): Promise<IntegrationSourceInspection> {
    return inspectIntegrationSource(this, identity, runId, sourceId);
  }

  mergeIntegrationSourceV2(identity: TaskboardIdentity, runId: string, sourceId: string) {
    return mergeIntegrationSource(this, identity, runId, sourceId);
  }

  linkIntegrationRemediationV2(
    identity: TaskboardIdentity,
    runId: string,
    sourceId: string,
    remediationTaskId: string,
  ) {
    return linkIntegrationRemediation(this, identity, runId, sourceId, remediationTaskId);
  }

  reconcileMergeOperationsV2(limit?: number): Promise<number> {
    return reconcileUnknownMergeOperations(this, limit);
  }

  claimIntegrationDispatchCandidatesV2(limit?: number) {
    return claimIntegrationDispatchCandidates(this, limit);
  }

  resolveExecutionV2(
    identity: TaskboardIdentity,
    runId: string,
    input: TaskBoardExecutionResolutionInput,
  ): Promise<TaskBoardTask> {
    return resolveStoredExecutionV2(this, identity, runId, input);
  }

  async listBoards(identity: TaskboardIdentity, includeArchived = false): Promise<TaskBoard[]> {
    return listStoredBoards(this, identity, includeArchived);
  }
  async searchBoards(
    identity: TaskboardIdentity,
    filter: TaskboardBoardSearchFilter = {},
  ): Promise<TaskboardPage<TaskBoard>> {
    return searchStoredBoards(this, identity, filter);
  }

  async getBoard(identity: TaskboardIdentity, boardId: string): Promise<TaskBoard> {
    return this.requireBoard(this.pool, identity, boardId, false);
  }
  async createBoard(identity: TaskboardIdentity, input: TaskBoardCreateInput): Promise<TaskBoard> {
    const name = requireText(input.name, 'Board name');
    const description = optionalText(input.description);
    const prompt = normalizeBoardPrompt(input.prompt ?? TASKBOARD_DEFAULT_PROMPT);
    const model = normalizeModel(input.model);
    const visibility = input.visibility ?? 'personal';
    const repository = normalizeRepositoryConfig(input.repository, identity.tenantId);
    if (repository && (!repository.owner || !repository.name || !repository.baseBranch)) {
      throw new TaskboardValidationError('Repository owner, name and base branch are required');
    }
    if (input.integrationPolicy && !repository) {
      throw new TaskboardValidationError(
        'Integration policy requires a repository',
        'TASKBOARD_REPOSITORY_REQUIRED',
      );
    }
    try {
      return await this.withTransaction(async (client) => {
        const boardId = randomUUID();
        const result = await client.query(
          `INSERT INTO ${this.boardsTable}
             (id, tenant_id, owner_user_id, name, description, visibility, prompt, model,
              repository, integration_policy, next_task_number, version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,1,1)
           RETURNING id, owner_user_id, name, description, visibility, prompt, model, repository, integration_policy, version,
                     archived_at, created_at, updated_at`,
          [
            boardId, identity.tenantId, identity.ownerUserId, name, description, visibility, prompt, model,
            repository ? JSON.stringify(repository) : null,
            input.integrationPolicy
              ? JSON.stringify({ ...input.integrationPolicy, revision: randomUUID() })
              : null,
          ],
        );
        if (repository) {
          await client.query(
            `INSERT INTO ${this.integrationLanesTable} (repository_id, board_id) VALUES ($1,$2)`,
            [repository.repositoryId, boardId],
          );
        }
        await appendBoardChange(this, client, boardId, 'board.created', 'user', identity.ownerUserId, {
          name,
          visibility,
          repositoryId: repository?.repositoryId,
          integrationPolicyRevision: input.integrationPolicy ? 'created' : undefined,
        });
        return rowToBoard(result.rows[0], identity.ownerUserId);
      });
    } catch (error) {
      throw mapActiveBoardNameError(error);
    }
  }
  async updateBoard(identity: TaskboardIdentity, boardId: string, input: TaskBoardPatchInput): Promise<TaskBoard> {
    return this.withTransaction(async (client) => {
      const current = await this.requireOwnedBoard(client, identity, boardId, true);
      assertExpectedVersion(current, input.expectedVersion);
      assertActiveBoard(current);
      if (
        input.name === undefined
        && input.description === undefined
        && input.prompt === undefined
        && input.model === undefined
        && input.visibility === undefined
        && input.repository === undefined
        && input.integrationPolicy === undefined
      ) {
        throw new TaskboardValidationError('No board changes supplied');
      }
      const assignments = ['version=version+1', 'updated_at=now()'];
      const params: unknown[] = [boardId, identity.tenantId, identity.ownerUserId];
      if (input.name !== undefined) {
        params.push(requireText(input.name, 'Board name'));
        assignments.push(`name=$${params.length}`);
      }
      if (input.description !== undefined) {
        params.push(optionalText(input.description));
        assignments.push(`description=$${params.length}`);
      }
      if (input.prompt !== undefined) {
        params.push(normalizeBoardPrompt(input.prompt));
        assignments.push(`prompt=$${params.length}`);
      }
      if (input.model !== undefined) {
        params.push(normalizeModel(input.model));
        assignments.push(`model=$${params.length}`);
      }
      if (input.visibility !== undefined) {
        params.push(input.visibility);
        assignments.push(`visibility=$${params.length}`);
      }
      const normalizedRepository = input.repository === undefined
        ? undefined
        : normalizeRepositoryConfig(input.repository, identity.tenantId);
      if (normalizedRepository && (!normalizedRepository.owner || !normalizedRepository.name || !normalizedRepository.baseBranch)) {
        throw new TaskboardValidationError('Repository owner, name and base branch are required');
      }
      if (input.repository !== undefined) {
        const nextRepositoryId = normalizedRepository?.repositoryId;
        const currentRepositoryId = current.repository?.repositoryId;
        const repositoryChanged = JSON.stringify(normalizedRepository ?? null) !== JSON.stringify(current.repository ?? null);
        if (repositoryChanged) {
          const protectedState = await client.query(
            `SELECT 1
               FROM ${this.tasksTable}
              WHERE board_id=$1 AND (provider_pull_request_id IS NOT NULL OR kind='integration')
              LIMIT 1`,
            [boardId],
          );
          if (protectedState.rows[0]) {
            throw new TaskboardValidationError(
              'Repository cannot change after pull requests or integration tasks exist',
              'TASKBOARD_REPOSITORY_IMMUTABLE',
            );
          }
        }
        if (nextRepositoryId !== currentRepositoryId) {
          await client.query(`DELETE FROM ${this.integrationLanesTable} WHERE board_id=$1`, [boardId]);
          if (normalizedRepository) {
            await client.query(
              `INSERT INTO ${this.integrationLanesTable} (repository_id, board_id) VALUES ($1,$2)`,
              [normalizedRepository.repositoryId, boardId],
            );
          }
        }
        params.push(normalizedRepository ? JSON.stringify(normalizedRepository) : null);
        assignments.push(`repository=$${params.length}::jsonb`);
      }
      if (input.integrationPolicy !== undefined) {
        const activeIntegration = await client.query(
          `SELECT 1 FROM ${this.integrationLanesTable}
            WHERE board_id=$1 AND active_integration_task_id IS NOT NULL LIMIT 1`,
          [boardId],
        );
        if (activeIntegration.rows[0]) {
          throw new TaskboardValidationError(
            'Integration policy cannot change while an integration task is active',
            'TASKBOARD_POLICY_ACTIVE',
          );
        }
        const repository = input.repository === undefined ? current.repository : normalizedRepository ?? undefined;
        if (input.integrationPolicy && !repository) {
          throw new TaskboardValidationError(
            'Integration policy requires a repository',
            'TASKBOARD_REPOSITORY_REQUIRED',
          );
        }
        const policy = input.integrationPolicy
          ? { ...input.integrationPolicy, revision: randomUUID() }
          : null;
        params.push(policy ? JSON.stringify(policy) : null);
        assignments.push(`integration_policy=$${params.length}::jsonb`);
        assignments.push('integration_next_run_at=NULL');
      }
      try {
        const result = await client.query(
          `UPDATE ${this.boardsTable}
              SET ${assignments.join(', ')}
            WHERE id=$1 AND tenant_id=$2 AND owner_user_id=$3
            RETURNING id, owner_user_id, name, description, visibility, prompt, model, repository, integration_policy, version,
                      archived_at, created_at, updated_at`,
          params,
        );
        const updated = rowToBoard(result.rows[0], identity.ownerUserId);
        await appendBoardChange(this, client, boardId, 'board.updated', 'user', identity.ownerUserId, {
          changedFields: Object.keys(input).filter((key) => key !== 'expectedVersion'),
          version: updated.version,
          repositoryId: updated.repository?.repositoryId,
          integrationPolicyRevision: updated.integrationPolicy?.revision,
        });
        return updated;
      } catch (error) {
        throw mapActiveBoardNameError(error);
      }
    });
  }
  async archiveBoard(
    identity: TaskboardIdentity,
    boardId: string,
    input: TaskboardExpectedVersionInput,
  ): Promise<TaskBoard> {
    return this.withTransaction(async (client) => {
      const current = await this.requireOwnedBoard(client, identity, boardId, true);
      assertExpectedVersion(current, input.expectedVersion);
      assertActiveBoard(current);
      await assertBoardHasNoActiveRuns(this, client, boardId);
      const result = await client.query(
        `UPDATE ${this.boardsTable}
            SET archived_at=now(), version=version+1, updated_at=now()
          WHERE id=$1 AND tenant_id=$2 AND owner_user_id=$3
          RETURNING id, owner_user_id, name, description, visibility, prompt, model, repository, integration_policy, version,
                    archived_at, created_at, updated_at`,
        [boardId, identity.tenantId, identity.ownerUserId],
      );
      const updated = rowToBoard(result.rows[0], identity.ownerUserId);
      await appendBoardChange(this, client, boardId, 'board.archived', 'user', identity.ownerUserId, {
        version: updated.version,
      }, true);
      return updated;
    });
  }
  async restoreBoard(
    identity: TaskboardIdentity,
    boardId: string,
    input: TaskboardExpectedVersionInput,
  ): Promise<TaskBoard> {
    return this.withTransaction(async (client) => {
      const current = await this.requireOwnedBoard(client, identity, boardId, true);
      assertExpectedVersion(current, input.expectedVersion);
      if (!current.archivedAt) {
        throw new TaskboardValidationError('Board is not archived', 'TASKBOARD_NOT_ARCHIVED');
      }
      try {
        const result = await client.query(
          `UPDATE ${this.boardsTable}
              SET archived_at=NULL, version=version+1, updated_at=now()
            WHERE id=$1 AND tenant_id=$2 AND owner_user_id=$3
            RETURNING id, owner_user_id, name, description, visibility, prompt, model, repository, integration_policy, version,
                    archived_at, created_at, updated_at`,
          [boardId, identity.tenantId, identity.ownerUserId],
        );
        const updated = rowToBoard(result.rows[0], identity.ownerUserId);
        await appendBoardChange(this, client, boardId, 'board.restored', 'user', identity.ownerUserId, {
          version: updated.version,
        });
        return updated;
      } catch (error) {
        throw mapActiveBoardNameError(error);
      }
    });
  }
  async listTasks(
    identity: TaskboardIdentity,
    boardId: string,
    filter: TaskboardTaskListFilter = {},
  ): Promise<TaskBoardTask[]> {
    await this.requireBoard(this.pool, identity, boardId, false);
    return listStoredTasks(this, identity, boardId, filter);
  }
  async searchTasks(
    identity: TaskboardIdentity,
    filter: TaskboardTaskSearchFilter = {},
  ): Promise<TaskboardPage<TaskBoardTask>> {
    return searchStoredTasks(this, identity, filter);
  }
  async createTask(identity: TaskboardIdentity, boardId: string, input: TaskBoardTaskCreateInput): Promise<TaskBoardTask> {
    return this.withTransaction(async (client) => {
      const board = await this.requireBoard(client, identity, boardId, true);
      assertBoardRole(board.role, 'editor');
      assertActiveBoard(board);
      if (input.kind === 'integration') {
        throw new TaskboardValidationError(
          'Integration tasks must be created from an integration batch',
          'TASKBOARD_INTEGRATION_CREATE_REQUIRES_BATCH',
        );
      }
      if (input.status && !['backlog', 'todo', 'in_progress'].includes(input.status)) {
        throw new TaskboardValidationError(
          'Initial task status is controlled by the taskboard workflow',
          'TASKBOARD_PROTECTED_TRANSITION',
        );
      }
      if (input.clientRequestId) {
        const existing = await client.query(
          `SELECT t.*, (SELECT count(*)::int FROM ${this.commentsTable} c WHERE c.task_id=t.id) AS comment_count FROM ${this.tasksTable} t WHERE t.board_id=$1 AND t.client_request_id=$2`,
          [boardId, input.clientRequestId],
        );
        if (existing.rows[0]) return rowToTask(existing.rows[0]);
      }
      const numberResult = await client.query(
        `UPDATE ${this.boardsTable}
            SET next_task_number=next_task_number+1
          WHERE id=$1 AND tenant_id=$2
            AND (owner_user_id=$3 OR visibility='organization')
          RETURNING next_task_number-1 AS task_number`,
        [boardId, identity.tenantId, identity.ownerUserId],
      );
      const taskNumber = Number(numberResult.rows[0]?.task_number);
      const status = input.status ?? 'backlog';
      const tailResult = await client.query(
        `SELECT COALESCE(MAX(t.sort_order), 0) AS max_sort_order
           FROM ${this.tasksTable} t
           JOIN ${this.boardsTable} b ON b.id=t.board_id
          WHERE t.board_id=$1 AND t.status=$2 AND t.archived_at IS NULL
            AND b.tenant_id=$3 AND (b.owner_user_id=$4 OR b.visibility='organization')`,
        [boardId, status, identity.tenantId, identity.ownerUserId],
      );
      const sortOrder = Number(tailResult.rows[0]?.max_sort_order ?? 0) + DEFAULT_SORT_GAP;
      const taskId = randomUUID();
      await client.query(
        `INSERT INTO ${this.tasksTable}
           (id, board_id, identifier, kind, title, description, branch, attachments, status, priority, labels,
            sort_order, due_at, model, provider_pull_request_id, pull_request_number,
            reviewed_subject_digest, creator_user_id, creator_name, completed_at, client_request_id, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
                 CASE WHEN $9='done' THEN now() END,$20,1)`,
        [
          taskId,
          boardId,
          `TASK-${taskNumber}`,
          input.kind ?? 'delivery',
          requireText(input.title, 'Task title'),
          input.description ?? '',
          optionalText(input.branch),
          JSON.stringify(normalizeAttachments(input.attachments)),
          status,
          input.priority ?? 'none',
          normalizeLabels(input.labels),
          sortOrder,
          input.dueAt ?? null,
          normalizeModel(input.model),
          optionalText(input.providerPullRequestId),
          input.pullRequestNumber ?? null,
          optionalText(input.reviewedSubjectDigest),
          identity.ownerUserId,
          identity.displayName?.trim() || identity.username,
          optionalText(input.clientRequestId),
        ],
      );
      await appendTaskChange(this, client, taskId, 'task.created', 'user', identity.ownerUserId, {
        kind: input.kind ?? 'delivery',
        status,
      });
      return this.requireTask(client, identity, taskId, false);
    });
  }
  async getTask(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardTask> {
    return this.requireTask(this.pool, identity, taskId, false);
  }
  async updateTask(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskBoardTaskPatchInput,
  ): Promise<TaskBoardTask> {
    return this.withTransaction(async (client) => {
      const loaded = await this.requireTaskWithBoard(client, identity, taskId, true);
      assertBoardRole(loaded.boardRole, 'editor');
      assertExpectedVersion(loaded.task, input.expectedVersion);
      assertWritableTask(loaded.task, loaded.boardArchivedAt);
      if (
        input.providerPullRequestId !== undefined
        || input.pullRequestNumber !== undefined
        || input.reviewedSubjectDigest !== undefined
      ) {
        throw new TaskboardValidationError(
          'Pull request identity and reviewed subject are protected fields',
          'TASKBOARD_PROTECTED_FIELD',
        );
      }
      if (
        input.title === undefined
        && input.description === undefined
        && input.branch === undefined
        && input.attachments === undefined
        && input.priority === undefined
        && input.labels === undefined
        && input.dueAt === undefined
        && input.model === undefined
      ) {
        throw new TaskboardValidationError('No task changes supplied');
      }
      const assignments = ['version=t.version+1', 'updated_at=now()'];
      const params: unknown[] = [taskId, identity.tenantId, identity.ownerUserId];
      if (input.title !== undefined) {
        params.push(requireText(input.title, 'Task title'));
        assignments.push(`title=$${params.length}`);
      }
      if (input.description !== undefined) {
        params.push(input.description);
        assignments.push(`description=$${params.length}`);
      }
      if (input.branch !== undefined) {
        params.push(optionalText(input.branch));
        assignments.push(`branch=$${params.length}`);
      }
      if (input.attachments !== undefined) {
        params.push(JSON.stringify(normalizeAttachments(input.attachments)));
        assignments.push(`attachments=$${params.length}::jsonb`);
      }
      if (input.priority !== undefined) {
        params.push(input.priority);
        assignments.push(`priority=$${params.length}`);
      }
      if (input.labels !== undefined) {
        params.push(normalizeLabels(input.labels));
        assignments.push(`labels=$${params.length}`);
      }
      if (input.dueAt !== undefined) {
        params.push(input.dueAt);
        assignments.push(`due_at=$${params.length}`);
      }
      if (input.model !== undefined) {
        params.push(normalizeModel(input.model));
        assignments.push(`model=$${params.length}`);
      }
      await client.query(
        `UPDATE ${this.tasksTable} t
            SET ${assignments.join(', ')}
           FROM ${this.boardsTable} b
          WHERE t.id=$1 AND t.board_id=b.id
            AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')`,
        params,
      );
      await appendTaskChange(this, client, taskId, 'task.updated', 'user', identity.ownerUserId, {
        fields: Object.keys(input).filter((key) => key !== 'expectedVersion'),
      });
      return this.requireTask(client, identity, taskId, false);
    });
  }
  async moveTask(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskBoardTaskMoveInput,
  ): Promise<TaskBoardTask> {
    return this.withTransaction(async (client) => {
      const loaded = await this.requireTaskWithBoard(client, identity, taskId, true);
      assertBoardRole(loaded.boardRole, input.status === loaded.task.status ? 'editor' : 'maintainer');
      assertExpectedVersion(loaded.task, input.expectedVersion);
      assertWritableTask(loaded.task, loaded.boardArchivedAt);
      if (input.status !== loaded.task.status) {
        if (loaded.task.kind === 'integration') {
          throw new TaskboardValidationError(
            'Integration state transitions are controlled by the integration workflow',
            'TASKBOARD_PROTECTED_TRANSITION',
          );
        }
        if (['in_progress', 'in_review', 'ready_to_merge', 'done'].includes(input.status)
          || ['in_progress', 'in_review', 'ready_to_merge', 'done'].includes(loaded.task.status)) {
          throw new TaskboardValidationError(
            'This state transition requires a workflow command',
            'TASKBOARD_PROTECTED_TRANSITION',
          );
        }
        await assertTaskHasNoActiveRuns(this, client, taskId);
      }
      if (input.previousTaskId === taskId || input.nextTaskId === taskId) {
        throw new TaskboardValidationError('A task cannot be its own move neighbor', 'TASKBOARD_INVALID_MOVE');
      }
      if (input.previousTaskId && input.previousTaskId === input.nextTaskId) {
        throw new TaskboardValidationError('Move neighbors must be different', 'TASKBOARD_INVALID_MOVE');
      }

      const peerResult = await client.query(
        `SELECT t.id, t.sort_order
           FROM ${this.tasksTable} t
           JOIN ${this.boardsTable} b ON b.id=t.board_id
          WHERE t.board_id=$1 AND t.id<>$2 AND t.status=$3 AND t.archived_at IS NULL
            AND b.tenant_id=$4 AND (b.owner_user_id=$5 OR b.visibility='organization')
          ORDER BY t.sort_order, t.created_at, t.id
          FOR UPDATE OF t`,
        [loaded.task.boardId, taskId, input.status, identity.tenantId, identity.ownerUserId],
      );
      const peers = peerResult.rows.map((row) => ({
        id: String(row.id),
        sortOrder: Number(row.sort_order),
      }));
      validateMoveNeighbors(peers, input.previousTaskId, input.nextTaskId);

      let previous = input.previousTaskId ? peers.find((peer) => peer.id === input.previousTaskId) : undefined;
      let next = input.nextTaskId ? peers.find((peer) => peer.id === input.nextTaskId) : undefined;
      if (previous && next && (!Number.isFinite(previous.sortOrder) || !Number.isFinite(next.sortOrder)
        || next.sortOrder - previous.sortOrder <= MIN_SORT_GAP)) {
        await this.renumberColumn(client, identity, loaded.task.boardId, peers);
        previous = peers.find((peer) => peer.id === input.previousTaskId);
        next = peers.find((peer) => peer.id === input.nextTaskId);
      }

      let sortOrder: number;
      if (previous && next) sortOrder = previous.sortOrder + (next.sortOrder - previous.sortOrder) / 2;
      else if (previous) sortOrder = previous.sortOrder + DEFAULT_SORT_GAP;
      else if (next) sortOrder = next.sortOrder - DEFAULT_SORT_GAP;
      else sortOrder = DEFAULT_SORT_GAP;

      await client.query(
        `UPDATE ${this.tasksTable} t
            SET status=$4,
                sort_order=$5,
                completed_at=CASE
                  WHEN $4='done' AND t.status<>'done' THEN now()
                  WHEN $4='done' THEN t.completed_at
                  ELSE NULL
                END,
                version=t.version+1,
                updated_at=now()
           FROM ${this.boardsTable} b
          WHERE t.id=$1 AND t.board_id=b.id
            AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')`,
        [taskId, identity.tenantId, identity.ownerUserId, input.status, sortOrder],
      );
      await appendTaskChange(this, client, taskId,
        input.status === loaded.task.status ? 'task.reordered' : 'task.transitioned',
        'user', identity.ownerUserId, { from: loaded.task.status, to: input.status });
      return this.requireTask(client, identity, taskId, false);
    });
  }
  async archiveTask(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskboardExpectedVersionInput,
  ): Promise<TaskBoardTask> {
    return this.setTaskArchived(identity, taskId, input.expectedVersion, true);
  }

  async restoreTask(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskboardExpectedVersionInput,
  ): Promise<TaskBoardTask> {
    return this.setTaskArchived(identity, taskId, input.expectedVersion, false);
  }

  async listComments(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardComment[]> {
    await this.requireTask(this.pool, identity, taskId, false);
    const result = await this.pool.query(
      `SELECT c.*
         FROM ${this.commentsTable} c
         JOIN ${this.tasksTable} t ON t.id=c.task_id
         JOIN ${this.boardsTable} b ON b.id=t.board_id
        WHERE c.task_id=$1 AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')
        ORDER BY c.created_at, c.id`,
      [taskId, identity.tenantId, identity.ownerUserId],
    );
    return result.rows.map((row) => applyCommentAuthorDisplayName(rowToComment(row), identity));
  }

  async searchComments(identity: TaskboardIdentity, taskId: string, filter: TaskboardPageFilter = {}): Promise<TaskboardPage<TaskBoardComment>> { return searchStoredComments(this, identity, taskId, filter); }

  async createComment(identity: TaskboardIdentity, taskId: string, input: TaskBoardCommentCreateInput): Promise<TaskBoardComment> {
    return this.withTransaction(async (client) => {
      const loaded = await this.requireTaskWithBoard(client, identity, taskId, true);
      assertBoardRole(loaded.boardRole, 'editor');
      assertWritableTask(loaded.task, loaded.boardArchivedAt);
      const body = input.body.trim();
      const attachments = normalizeAttachments(input.attachments);
      if (!body && attachments.length === 0) throw new TaskboardValidationError('Comment body or attachment is required');
      const result = await client.query(
        `INSERT INTO ${this.commentsTable}
           (id, task_id, body, attachments, author_type, author_id, author_name, continuation_eligible, version)
         VALUES ($1,$2,$3,$4::jsonb,'user',$5,$6,true,1)
         RETURNING *`,
        [randomUUID(), taskId, body, JSON.stringify(attachments), identity.ownerUserId,
          identity.displayName || identity.username],
      );
      await appendTaskChange(this, client, taskId, 'comment.created', 'user', identity.ownerUserId, {
        commentId: String(result.rows[0].id),
      });
      return rowToComment(result.rows[0]);
    });
  }

  async updateComment(
    identity: TaskboardIdentity,
    commentId: string,
    input: TaskBoardCommentPatchInput,
  ): Promise<TaskBoardComment> {
    return updateStoredComment(this, identity, commentId, input);
  }

  async deleteComment(
    identity: TaskboardIdentity,
    commentId: string,
    input: TaskboardExpectedVersionInput,
  ): Promise<TaskBoardComment> {
    return deleteStoredComment(this, identity, commentId, input);
  }

  listExecutions(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardExecution[]> {
    return listTaskExecutions(this, identity, taskId);
  }

  async searchExecutions(
    identity: TaskboardIdentity,
    taskId: string,
    filter: TaskboardPageFilter = {},
  ): Promise<TaskboardPage<TaskBoardExecution>> {
    return searchStoredExecutions(this, identity, taskId, filter);
  }

  async getExecutionModelContext(identity: TaskboardIdentity, taskId: string): Promise<TaskboardExecutionModelContext> {
    const [context, loaded] = await Promise.all([
      loadExecutionModelContext(this, identity, taskId),
      this.requireTaskWithBoard(this.pool, identity, taskId, false),
    ]);
    return {
      ...context,
      allowedActions: allowedActionsForRole(loaded.boardRole ?? 'viewer'),
    };
  }
  async claimExecution(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskboardExecutionClaimInput,
  ): Promise<TaskBoardExecutionStartResult> {
    return claimStoredExecution(this, identity, taskId, input);
  }
  getExecutionContextByRunId(runId: string): Promise<TaskboardExecutionContext | null> {
    return loadExecutionContext(this, runId);
  }

  async getExecutionContextBySessionId(sessionId: string): Promise<TaskboardExecutionContext | null> {
    return getStoredExecutionContextBySessionId(this, sessionId);
  }

  getContinuationContext(identity: TaskboardIdentity, taskId: string, commentId: string) {
    return loadContinuationContext(this, identity, taskId, commentId);
  }

  async updateTaskBranchFromExecution(
    identity: TaskboardIdentity,
    runId: string,
    branch: string | null,
  ): Promise<TaskBoardTask> {
    return updateStoredTaskBranchFromExecution(this, identity, runId, branch);
  }

  async createTaskFromExecution(
    identity: TaskboardIdentity,
    runId: string,
    input: TaskBoardTaskCreateInput,
  ): Promise<TaskBoardTask> {
    return createStoredTaskFromExecution(this, identity, runId, input);
  }
  enqueueContinuation(
    taskId: string,
    commentIds: string[],
    runId: string,
    commentId: string,
    payload: TaskboardContinuationDispatchPayload,
  ) {
    return enqueueContinuation(this, taskId, commentIds, runId, commentId, payload);
  }
  claimContinuationDispatch(
    runId: string | undefined,
    leaseId: string,
  ): Promise<TaskboardContinuationDispatch | null> {
    return claimContinuationDispatch(this, runId, leaseId);
  }
  markContinuationDispatchSucceeded(runId: string, leaseId: string) {
    return markContinuationDispatchSucceeded(this, runId, leaseId);
  }
  retryContinuationDispatch(runId: string, leaseId: string, error: string, delayMs: number) {
    return retryContinuationDispatch(this, runId, leaseId, error, delayMs);
  }
  claimContinuationReconcileCandidates(
    staleBefore: Date,
    limit: number,
    leaseId: string,
  ): Promise<TaskboardContinuationReconcileCandidate[]> {
    return claimContinuationReconcileCandidates(this, staleBefore, limit, leaseId);
  }
  releaseContinuationReconcile(runId: string, leaseId: string) {
    return releaseContinuationReconcile(this, runId, leaseId);
  }
  finishContinuation(runId: string, leaseId?: string) {
    return finishContinuation(this, runId, leaseId);
  }
  markContinuationRunning(taskId: string, runId: string, reconcileLeaseId?: string) {
    return markContinuationRunning(this, taskId, runId, reconcileLeaseId);
  }
  completeContinuation(taskId: string, runId: string, input: TaskboardExecutionCompletionInput) {
    return completeContinuation(this, taskId, runId, input);
  }
  async moveTaskFromExecution(
    identity: TaskboardIdentity,
    runId: string,
    status: 'ready_to_merge' | 'todo' | 'blocked',
  ): Promise<TaskBoardTask> {
    return moveTaskFromReviewExecution(this, identity, runId, status);
  }
  claimExecutionDispatch(runId: string | undefined, leaseId: string) {
    return claimExecutionDispatch(this, runId, leaseId);
  }
  markExecutionDispatchSucceeded(runId: string, leaseId: string) {
    return markExecutionDispatchSucceeded(this, runId, leaseId);
  }
  retryExecutionDispatch(runId: string, leaseId: string, error: string, delayMs: number) {
    return retryExecutionDispatch(this, runId, leaseId, error, delayMs);
  }
  claimExecutionReconcileCandidates(staleBefore: Date, limit: number, leaseId: string) {
    return claimExecutionReconcileCandidates(this, staleBefore, limit, leaseId);
  }

  async setExecutionStatus(
    runId: string,
    status: 'running' | 'waiting_user' | 'waiting_approval',
  ): Promise<TaskBoardExecution | null> {
    return setStoredExecutionStatus(this, runId, status);
  }

  async setExecutionStatusFromReconcile(
    runId: string,
    status: 'running' | 'waiting_user' | 'waiting_approval',
    leaseId: string,
  ): Promise<TaskBoardExecution | null> {
    return setStoredExecutionStatusFromReconcile(this, runId, status, leaseId);
  }

  async completeExecution(
    runId: string,
    input: TaskboardExecutionCompletionInput,
  ): Promise<TaskBoardExecutionStartResult | null> {
    return completeStoredExecution(this, runId, input);
  }

  async completeExecutionFromReconcile(
    runId: string,
    input: TaskboardExecutionCompletionInput,
    leaseId: string,
  ): Promise<TaskBoardExecutionStartResult | null> {
    return completeStoredExecutionFromReconcile(this, runId, input, leaseId);
  }
  private async setTaskArchived(
    identity: TaskboardIdentity,
    taskId: string,
    expectedVersion: number,
    archive: boolean,
  ): Promise<TaskBoardTask> {
    return this.withTransaction(async (client) => {
      const loaded = await this.requireTaskWithBoard(client, identity, taskId, true);
      assertBoardRole(loaded.boardRole, 'maintainer');
      assertExpectedVersion(loaded.task, expectedVersion);
      if (loaded.boardArchivedAt) {
        throw new TaskboardValidationError('Archived boards are read-only', 'TASKBOARD_BOARD_ARCHIVED');
      }
      if (archive ? Boolean(loaded.task.archivedAt) : !loaded.task.archivedAt) {
        throw new TaskboardValidationError(
          archive ? 'Task is already archived' : 'Task is not archived',
          archive ? 'TASKBOARD_TASK_ARCHIVED' : 'TASKBOARD_TASK_NOT_ARCHIVED',
        );
      }
      if (archive) await assertTaskHasNoActiveRuns(this, client, taskId);
      await client.query(
        `UPDATE ${this.tasksTable} t
            SET archived_at=${archive ? 'now()' : 'NULL'}, version=t.version+1, updated_at=now()
           FROM ${this.boardsTable} b
          WHERE t.id=$1 AND t.board_id=b.id
            AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')`,
        [taskId, identity.tenantId, identity.ownerUserId],
      );
      await appendTaskChange(
        this,
        client,
        taskId,
        archive ? 'task.archived' : 'task.restored',
        'user',
        identity.ownerUserId,
        { archived: archive },
        archive,
      );
      return this.requireTask(client, identity, taskId, false);
    });
  }

  private async renumberColumn(
    client: PoolClient,
    identity: TaskboardIdentity,
    boardId: string,
    peers: Array<{ id: string; sortOrder: number }>,
  ): Promise<void> {
    for (const [index, peer] of peers.entries()) {
      peer.sortOrder = (index + 1) * DEFAULT_SORT_GAP;
      await client.query(
        `UPDATE ${this.tasksTable} t
            SET sort_order=$4, version=t.version+1, updated_at=now()
           FROM ${this.boardsTable} b
          WHERE t.id=$1 AND t.board_id=b.id AND t.board_id=$5
            AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')`,
        [peer.id, identity.tenantId, identity.ownerUserId, peer.sortOrder, boardId],
      );
    }
  }

  private requireBoard(
    db: PgPool | PoolClient,
    identity: TaskboardIdentity,
    boardId: string,
    forUpdate: boolean,
  ): Promise<TaskBoard> {
    return this.loadBoard(db, identity, boardId, forUpdate, false);
  }

  private requireOwnedBoard(
    db: PgPool | PoolClient,
    identity: TaskboardIdentity,
    boardId: string,
    forUpdate: boolean,
  ): Promise<TaskBoard> {
    return this.loadBoard(db, identity, boardId, forUpdate, true);
  }

  private async loadBoard(
    db: PgPool | PoolClient,
    identity: TaskboardIdentity,
    boardId: string,
    forUpdate: boolean,
    ownerOnly: boolean,
  ): Promise<TaskBoard> {
    const result = await db.query(
      `SELECT b.id, b.owner_user_id, b.name, b.description, b.visibility, b.prompt, b.model,
              b.repository, b.integration_policy, b.version, b.archived_at, b.created_at, b.updated_at,
              CASE WHEN b.owner_user_id=$3 THEN 'owner' ELSE COALESCE(m.role,'viewer') END AS board_role
         FROM ${this.boardsTable} b
         LEFT JOIN ${this.membersTable} m ON m.board_id=b.id AND m.user_id=$3
        WHERE b.id=$1 AND b.tenant_id=$2
          AND (b.owner_user_id=$3 OR ($4::boolean=false AND b.visibility='organization'))
        ${forUpdate ? 'FOR UPDATE OF b' : ''}`,
      [boardId, identity.tenantId, identity.ownerUserId, ownerOnly],
    );
    if (!result.rows[0]) throw new TaskboardNotFoundError('Board not found');
    return rowToBoard(result.rows[0], identity.ownerUserId);
  }

  async requireTask(
    db: PgPool | PoolClient,
    identity: TaskboardIdentity,
    taskId: string,
    forUpdate: boolean,
  ): Promise<TaskBoardTask> {
    return (await this.requireTaskWithBoard(db, identity, taskId, forUpdate)).task;
  }

  async requireTaskWithBoard(
    db: PgPool | PoolClient,
    identity: TaskboardIdentity,
    taskId: string,
    forUpdate: boolean,
  ): Promise<{
    task: TaskBoardTask;
    boardArchivedAt?: string;
    boardModel?: string; boardRepository?: TaskBoardRepositoryConfig;
    boardOwnerUserId: string;
    boardRole: TaskBoard['role'];
  }> {
    let lockedBoard: TaskBoard | undefined;
    if (forUpdate) {
      const ownership = await db.query(
        `SELECT t.board_id
           FROM ${this.tasksTable} t
           JOIN ${this.boardsTable} b ON b.id=t.board_id
          WHERE t.id=$1 AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')`,
        [taskId, identity.tenantId, identity.ownerUserId],
      );
      if (!ownership.rows[0]) throw new TaskboardNotFoundError('Task not found');
      lockedBoard = await this.requireBoard(
        db,
        identity,
        String(ownership.rows[0].board_id),
        true,
      );
    }

    const result = await db.query(
      `SELECT t.*,
              b.archived_at AS board_archived_at,
              b.model AS board_model, b.repository AS board_repository,
              b.owner_user_id AS board_owner_user_id, m.role AS board_member_role,
              (SELECT count(*)::int FROM ${this.commentsTable} c WHERE c.task_id=t.id) AS comment_count
         FROM ${this.tasksTable} t
         JOIN ${this.boardsTable} b ON b.id=t.board_id LEFT JOIN ${this.membersTable} m ON m.board_id=b.id AND m.user_id=$3
        WHERE t.id=$1 AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')
        ${forUpdate ? 'FOR UPDATE OF t' : ''}`,
      [taskId, identity.tenantId, identity.ownerUserId],
    );
    if (!result.rows[0]) throw new TaskboardNotFoundError('Task not found');
    const row = result.rows[0];
    const boardArchivedAt = lockedBoard?.archivedAt
      ?? (row.board_archived_at ? toIso(row.board_archived_at) : undefined);
    const boardModel = lockedBoard?.model
      ?? (row.board_model ? String(row.board_model) : undefined);
    return {
      task: rowToTask(row),
      ...(boardArchivedAt ? { boardArchivedAt } : {}),
      ...(boardModel ? { boardModel } : {}), ...boardRepositoryFragment(lockedBoard?.repository, row.board_repository),
      boardOwnerUserId: lockedBoard?.ownerUserId ?? String(row.board_owner_user_id),
      boardRole: lockedBoard?.role ?? (String(row.board_owner_user_id) === identity.ownerUserId ? 'owner' : row.board_member_role ? String(row.board_member_role) as TaskBoard['role'] : 'viewer'),
    };
  }


  async withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
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
}

function assertBoardRole(
  role: TaskBoard['role'],
  minimum: 'editor' | 'maintainer' | 'owner',
): void {
  const rank = role === 'owner' ? 4 : role === 'maintainer' ? 3 : role === 'editor' ? 2 : 1;
  const required = minimum === 'owner' ? 4 : minimum === 'maintainer' ? 3 : 2;
  if (rank < required) {
    throw new TaskboardPermissionError('Taskboard role does not allow this operation');
  }
}
