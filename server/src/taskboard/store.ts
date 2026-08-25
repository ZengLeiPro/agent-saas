import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import {
  TASKBOARD_DEFAULT_PROMPT, type TaskBoard, type TaskBoardComment, type TaskBoardCommentCreateInput,
  type TaskBoardCommentPatchInput, type TaskBoardCreateInput, type TaskBoardExecution,
  type TaskBoardExecutionContextInput, type TaskBoardExecutionContextResponse, type TaskBoardExecutionTransitionInput,
  type TaskBoardExecutionStartResult, type TaskBoardIntegrationBatchCreateInput, type TaskBoardIntegrationSource,
  type TaskBoardMember, type TaskBoardMemberPatchInput, type TaskBoardPatchInput, type TaskBoardRepositoryConfig,
  type TaskBoardTask, type TaskBoardTaskCreateInput, type TaskBoardTaskMoveInput, type TaskBoardTaskPatchInput,
} from '../../../shared/src/types/taskboard.js';
import {
  completeContinuation, listTaskExecutions, loadContinuationContext, loadExecutionContext,
  loadExecutionModelContext, markContinuationRunning, nextTaskColumnSortOrder,
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
  createTaskFromExecutionWithResult as createStoredTaskFromExecutionWithResult,
  updateTaskBranchFromExecution as updateStoredTaskBranchFromExecution,
} from './executionTaskActions.js';
import { moveTaskFromReviewExecution } from './executionTaskMove.js';
import { integrationAgentTableNames } from './integrationAgentSchema.js';
import { requireIntegrationAgentRendezvous } from './legacyIntegrationAgentMigration.js';
import { clearBoardCiPolicyForRepositoryChange, normalizeIntegrationPolicyCiFallback } from './ciPolicy.js';
import { discoverBoardCiPolicy } from './ciPolicyDiscovery.js';
import { deleteStoredTask, rollbackStoredTask } from './storeTaskDelete.js';
import { describeTaskUpdate, resolveTaskKindMutation } from './storeTaskPromotion.js';
import {
  allowedActionsForRole,
  appendModelAssignments,
  normalizeBoardPrompt,
  normalizeModel,
  normalizeRepositoryConfig,
  rowToBoard, stageModelsToJson, stagePromptsToJson,
} from './boardFields.js';
import type { RepositoryProvider } from './repositoryProvider.js';
import { claimIntegrationDispatchCandidates } from './integrationTriggers.js';
import { mergeIntegrationAgent } from './integrationAgentMerge.js';
import {
  attachExecutionPullRequest, inspectExecutionPullRequest, readExecutionPullRequestJobLog,
  recordReviewedExecutionSubject, type ExecutionPullRequestInspection,
} from './deliveryPullRequests.js';
import {
  inspectIntegrationSource, linkIntegrationRemediation, mergeIntegrationSource, readIntegrationSourceJobLog,
  reconcileUnknownMergeOperations, type IntegrationSourceInspection,
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
  upsertBoardMember as upsertStoredBoardMember,
} from './v2Store.js';
import { transitionExecutionV2 as transitionStoredExecutionV2 } from './workflow/transitionService.js';
import { resumeBlockedTask as resumeStoredBlockedTask } from './workflow/resumeService.js';
import {
  assertActiveBoard,
  assertBoardRole,
  assertExpectedVersion,
  assertTaskContent,
  assertWritableTask,
  mapActiveBoardNameError,
  normalizeAttachments,
  normalizeLabels,
  optionalText,
  requireText,
  rowToComment,
  rowToTask,
  sanitizeIdentifier,
  validateMoveNeighbors, visibleCommentPredicate,
} from './storeHelpers.js';
import { assertBoardHasNoActiveRuns, assertTaskHasNoActiveRuns, assertTaskHasNoExecutionHistory } from './archiveGuard.js';
import { completeStoredTaskCreation, createStoredTask, createStoredTaskWithResult, releaseStoredTaskCreation } from './storeTaskCreate.js';
import { deleteComment as deleteStoredComment, updateComment as updateStoredComment } from './storeComments.js';
import { applyGeneratedTaskTitle } from './storeGeneratedTaskTitle.js';
import { getExecutionContextBySessionId as getStoredExecutionContextBySessionId, searchExecutions as searchStoredExecutions } from './storeExecutions.js';
import {
  listBoards as listStoredBoards,
  listComments as listStoredComments,
  listTasks as listStoredTasks,
  searchBoards as searchStoredBoards,
  searchComments as searchStoredComments,
  searchTasks as searchStoredTasks,
} from './storeSearch.js';
import { initializeTaskboardStore } from './storeSchema.js';
import { loadBoard as loadStoredBoard, requireTaskWithBoard as requireStoredTaskWithBoard } from './storeTaskAccess.js';
import { isStoredTaskWatched, setStoredTaskWatched } from './taskWatchStore.js';
import {
  claimWorkflowCancellations as claimStoredWorkflowCancellations,
  finishWorkflowCancellation as finishStoredWorkflowCancellation,
} from './workflow/cancellationOutbox.js';
import {
  claimExecution as claimStoredExecution,
  completeExecution as completeStoredExecution,
  completeExecutionFromReconcile as completeStoredExecutionFromReconcile,
  setExecutionStatus as setStoredExecutionStatus,
  setExecutionStatusFromReconcile as setStoredExecutionStatusFromReconcile,
} from './storeExecutionLifecycle.js';
import {
  TaskboardNotFoundError,
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
  type TaskboardTaskCreateResult,
  type TaskboardTaskListFilter,
  type TaskboardTaskSearchFilter,
} from './types.js';
const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;
const DEFAULT_SORT_GAP = 1024; const MIN_SORT_GAP = 1e-7;
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
  readonly remediationAttemptsTable: string;
  readonly cancellationOutboxTable: string; readonly watchersTable: string; readonly statusNotificationOutboxTable: string;
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
    this.remediationAttemptsTable = `${prefix}_taskboard_remediation_attempts`;
    this.cancellationOutboxTable = `${prefix}_taskboard_cancel_outbox`; this.watchersTable = `${prefix}_taskboard_watchers`; this.statusNotificationOutboxTable = `${prefix}_taskboard_status_notify_outbox`;
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
  resumeBlockedTask(
    identity: TaskboardIdentity,
    taskId: string,
    input: { expectedVersion: number; decision: string; sourceIds?: string[] },
  ): Promise<TaskBoardTask> {
    return resumeStoredBlockedTask(this, identity, taskId, input);
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
  getRepositoryProvider(): RepositoryProvider | undefined { return this.repositoryProvider; }


  attachExecutionPullRequestV2(
    identity: TaskboardIdentity,
    runId: string,
    providerPullRequestId: string,
  ): Promise<TaskBoardTask> {
    return attachExecutionPullRequest(this, identity, runId, providerPullRequestId);
  }

  inspectExecutionPullRequestV2(identity: TaskboardIdentity, runId: string): Promise<ExecutionPullRequestInspection> {
    return inspectExecutionPullRequest(this, identity, runId);
  }

  readExecutionPullRequestJobLogV2(
    identity: TaskboardIdentity,
    runId: string,
    inspectionId: string,
    providerJobId: string,
  ): Promise<{ inspectionId: string; providerJobId: string; log: string }> {
    return readExecutionPullRequestJobLog(this, identity, runId, inspectionId, providerJobId);
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
  readIntegrationSourceJobLogV2(identity: TaskboardIdentity, runId: string, sourceId: string, inspectionId: string, providerJobId: string) {
    return readIntegrationSourceJobLog(this, identity, runId, sourceId, inspectionId, providerJobId);
  }
  mergeIntegrationSourceV2(identity: TaskboardIdentity, runId: string, sourceId: string) {
    return mergeIntegrationSource(this, identity, runId, sourceId);
  }
  mergeIntegrationAgentV2(identity: TaskboardIdentity, runId: string) {
    return mergeIntegrationAgent(this, identity, runId);
  }
  linkIntegrationRemediationV2(
    identity: TaskboardIdentity,
    runId: string,
    sourceId: string,
    remediationTaskId: string,
  ) {
    return linkIntegrationRemediation(this, identity, runId, sourceId, remediationTaskId);
  }
  claimWorkflowCancellations(limit = 20): Promise<Array<{ id: string; runId: string; reason: string }>> {
    return claimStoredWorkflowCancellations(this, limit);
  }
  finishWorkflowCancellation(id: string, error?: string): Promise<void> {
    return finishStoredWorkflowCancellation(this, id, error);
  }
  reconcileMergeOperationsV2(limit?: number): Promise<number> {
    return reconcileUnknownMergeOperations(this, limit);
  }
  claimIntegrationDispatchCandidatesV2(limit?: number) {
    return claimIntegrationDispatchCandidates(this, limit);
  }

  transitionExecutionV2(
    identity: TaskboardIdentity,
    runId: string,
    input: TaskBoardExecutionTransitionInput,
  ): Promise<TaskBoardTask> {
    return transitionStoredExecutionV2(this, identity, runId, input);
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
  getBoardCiPolicyDiscovery(identity: TaskboardIdentity, boardId: string) { return discoverBoardCiPolicy(this, identity, boardId); }
  async createBoard(identity: TaskboardIdentity, input: TaskBoardCreateInput): Promise<TaskBoard> {
    const integrationPolicy = input.integrationPolicy && normalizeIntegrationPolicyCiFallback(input.integrationPolicy);
    const name = requireText(input.name, 'Board name');
    const description = optionalText(input.description);
    const prompt = normalizeBoardPrompt(input.prompt ?? TASKBOARD_DEFAULT_PROMPT);
    const model = normalizeModel(input.model);
    const visibility = input.visibility ?? 'personal';
    const repository = normalizeRepositoryConfig(input.repository, identity.tenantId);
    if (repository && (!repository.owner || !repository.name || !repository.baseBranch)) {
      throw new TaskboardValidationError('Repository owner, name and base branch are required');
    }
    if (integrationPolicy && !repository) throw new TaskboardValidationError(
      'Integration policy requires a repository', 'TASKBOARD_REPOSITORY_REQUIRED',
    );
    try {
      return await this.withTransaction(async (client) => {
        const boardId = randomUUID();
        const result = await client.query(
          `INSERT INTO ${this.boardsTable}
             (id, tenant_id, owner_user_id, name, description, visibility, prompt, model, stage_models, stage_prompts,
              repository, integration_policy, next_task_number, version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,1,1)
           RETURNING id, owner_user_id, name, description, visibility, prompt, model, stage_models, stage_prompts, repository, integration_policy, version, archived_at, created_at, updated_at`,
          [
            boardId, identity.tenantId, identity.ownerUserId, name, description, visibility, prompt, model,
            stageModelsToJson(input.stageModels), stagePromptsToJson(input.stagePrompts),
            repository ? JSON.stringify(repository) : null,
            integrationPolicy
              ? JSON.stringify({ ...integrationPolicy, revision: randomUUID() })
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
          integrationPolicyRevision: integrationPolicy ? 'created' : undefined,
        });
        return rowToBoard(result.rows[0], identity.ownerUserId);
      });
    } catch (error) {
      throw mapActiveBoardNameError(error);
    }
  }
  async updateBoard(identity: TaskboardIdentity, boardId: string, input: TaskBoardPatchInput): Promise<TaskBoard> {
    const inputPolicy = input.integrationPolicy && normalizeIntegrationPolicyCiFallback(input.integrationPolicy);
    return this.withTransaction(async (client) => {
      const current = await this.requireOwnedBoard(client, identity, boardId, true);
      assertExpectedVersion(current, input.expectedVersion);
      assertActiveBoard(current);
      const fieldValues = [input.name, input.description, input.prompt, input.model, input.stageModels,
        input.stagePrompts, input.visibility, input.repository, input.integrationPolicy];
      if (fieldValues.every((v) => v === undefined)) {
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
      if (input.stagePrompts !== undefined) {
        assignments.push(`stage_prompts=$${params.push(stagePromptsToJson(input.stagePrompts))}::jsonb`);
      }
      if (input.model !== undefined) {
        params.push(normalizeModel(input.model));
        assignments.push(`model=$${params.length}`);
      }
      if (input.stageModels !== undefined) {
        params.push(stageModelsToJson(input.stageModels));
        assignments.push(`stage_models=$${params.length}::jsonb`);
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
      const effectiveRepository = input.repository === undefined ? current.repository : normalizedRepository ?? undefined;
      const reboundPolicy = clearBoardCiPolicyForRepositoryChange(
        current.repository,
        effectiveRepository,
        input.integrationPolicy === undefined ? current.integrationPolicy : inputPolicy ?? undefined,
      );
      const effectivePolicy = reboundPolicy.policy;
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
      if (input.integrationPolicy !== undefined || reboundPolicy.cleared) {
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
        if (effectivePolicy && !effectiveRepository) {
          throw new TaskboardValidationError(
            'Integration policy requires a repository',
            'TASKBOARD_REPOSITORY_REQUIRED',
          );
        }
        const policy = effectivePolicy
          ? { ...effectivePolicy, revision: randomUUID() }
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
            RETURNING id, owner_user_id, name, description, visibility, prompt, model, stage_models, stage_prompts, repository, integration_policy, version, archived_at, created_at, updated_at`,
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
          RETURNING id, owner_user_id, name, description, visibility, prompt, model, stage_models, stage_prompts, repository, integration_policy, version, archived_at, created_at, updated_at`,
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
            RETURNING id, owner_user_id, name, description, visibility, prompt, model, stage_models, stage_prompts, repository, integration_policy, version, archived_at, created_at, updated_at`,
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
    return createStoredTask(this, identity, boardId, input);
  }
  async createTaskWithResult(identity: TaskboardIdentity, boardId: string, input: TaskBoardTaskCreateInput, requestDigest?: string): Promise<TaskboardTaskCreateResult> {
    return createStoredTaskWithResult(this, identity, boardId, input, requestDigest);
  }
  async completeTaskCreation(identity: TaskboardIdentity, taskId: string, claimToken: string): Promise<TaskBoardTask> { return completeStoredTaskCreation(this, identity, taskId, claimToken); }
  async releaseTaskCreation(identity: TaskboardIdentity, taskId: string, claimToken: string): Promise<void> { return releaseStoredTaskCreation(this, identity, taskId, claimToken); }
  async getTask(identity: TaskboardIdentity, taskId: string, creationClaimToken?: string): Promise<TaskBoardTask> {
    return this.requireTask(this.pool, identity, taskId, false, creationClaimToken);
  }
  isTaskWatched(identity: TaskboardIdentity, taskId: string): Promise<boolean> { return isStoredTaskWatched(this, identity, taskId); }
  setTaskWatched(identity: TaskboardIdentity, taskId: string, watched: boolean): Promise<boolean> { return setStoredTaskWatched(this, identity, taskId, watched); }
  async updateTask(identity: TaskboardIdentity, taskId: string, input: TaskBoardTaskPatchInput, creationClaimToken?: string): Promise<TaskBoardTask> {
    return this.withTransaction(async (client) => {
      const loaded = await this.requireTaskWithBoard(client, identity, taskId, true, creationClaimToken);
      const kindMutation = resolveTaskKindMutation(loaded.task, input.kind);
      assertBoardRole(loaded.boardRole, kindMutation.requiredRole);
      assertExpectedVersion(loaded.task, input.expectedVersion);
      assertWritableTask(loaded.task, loaded.boardArchivedAt);
      if (input.title !== undefined || input.description !== undefined || input.attachments !== undefined) {
        await assertTaskHasNoExecutionHistory(this, client, taskId);
      }
      if (input.title !== undefined || input.description !== undefined) assertTaskContent(input.title ?? loaded.task.title, input.description ?? loaded.task.description);
      if (kindMutation.promoting) await assertTaskHasNoActiveRuns(this, client, taskId);
      if (loaded.task.kind === 'advisory' && !kindMutation.promoting && input.branch !== undefined) {
        throw new TaskboardValidationError(
          'Advisory tasks cannot carry a repository branch',
          'TASKBOARD_ADVISORY_REPOSITORY_FORBIDDEN',
        );
      }
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
        input.title === undefined && input.description === undefined && input.kind === undefined
        && input.branch === undefined && input.attachments === undefined && input.priority === undefined && input.labels === undefined
        && input.dueAt === undefined && input.model === undefined && input.stageModels === undefined
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
      if (kindMutation.promoting) assignments.push("kind='delivery'", "status='todo'", 'completed_at=NULL', 'resume_context=NULL');
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
      appendModelAssignments(params, assignments, input.model, input.stageModels);
      await client.query(
        `UPDATE ${this.tasksTable} t
            SET ${assignments.join(', ')}
           FROM ${this.boardsTable} b
          WHERE t.id=$1 AND t.board_id=b.id
            AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')`,
        params,
      );
      const change = describeTaskUpdate(loaded.task, input);
      await appendTaskChange(this, client, taskId, change.type, 'user', identity.ownerUserId, change.payload);
      return this.requireTask(client, identity, taskId, false, creationClaimToken);
    });
  }
  async applyGeneratedTaskTitle(identity: TaskboardIdentity, taskId: string, title: string): Promise<TaskBoardTask> { return applyGeneratedTaskTitle(this, identity, taskId, title); }
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
        if (['in_progress', 'in_review', 'ready_to_merge', 'blocked', 'done'].includes(input.status)
          || ['in_progress', 'in_review', 'ready_to_merge', 'blocked', 'done'].includes(loaded.task.status)) {
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

  async deleteTask(identity: TaskboardIdentity, taskId: string, input: TaskboardExpectedVersionInput): Promise<TaskBoardTask> {
    return this.withTransaction((client) => deleteStoredTask(this, client, identity, taskId, input.expectedVersion));
  }
  async rollbackTaskCreation(identity: TaskboardIdentity, taskId: string, input: TaskboardExpectedVersionInput): Promise<TaskBoardTask> { return this.withTransaction((client) => rollbackStoredTask(this, client, identity, taskId, input.expectedVersion)); }
  async listComments(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardComment[]> {
    await this.requireTask(this.pool, identity, taskId, false);
    return listStoredComments(this, identity, taskId);
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
         VALUES ($1,$2,$3,$4::jsonb,'user',$5,$6,$7,1)
         RETURNING *`,
        [randomUUID(), taskId, body, JSON.stringify(attachments), identity.ownerUserId,
          identity.displayName || identity.username,
          !['done', 'canceled', 'blocked'].includes(loaded.task.status) && !loaded.task.mergedCommitOid],
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
    identity: TaskboardIdentity, runId: string, input: TaskBoardTaskCreateInput,
  ): Promise<TaskBoardTask> { return createStoredTaskFromExecution(this, identity, runId, input); }
  async createTaskFromExecutionWithResult(identity: TaskboardIdentity, runId: string, input: TaskBoardTaskCreateInput, requestDigest?: string) {
    return createStoredTaskFromExecutionWithResult(this, identity, runId, input, requestDigest);
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
      if (archive) {
        await assertTaskHasNoActiveRuns(this, client, taskId);
        if (loaded.task.kind === 'integration' && (loaded.task.workflowVersion ?? 2) === 3) {
          await requireIntegrationAgentRendezvous(this, client, loaded.task);
          const { agentsTable } = integrationAgentTableNames(this.integrationSourcesTable);
          const agent = await client.query(
            `SELECT status FROM ${agentsTable} WHERE integration_task_id=$1 FOR UPDATE`, [taskId]);
          if (!agent.rows[0] || !['merged','canceled'].includes(String(agent.rows[0].status))) {
            throw new TaskboardValidationError(
              'Integration Agent must be canceled or merged before archive',
              'TASKBOARD_AGENT_ARCHIVE_REQUIRES_TERMINAL_STATUS',
            );
          }
        }
      }
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

  requireBoard(
    db: PgPool | PoolClient,
    identity: TaskboardIdentity,
    boardId: string,
    forUpdate: boolean,
  ): Promise<TaskBoard> {
    return loadStoredBoard(this, db, identity, boardId, forUpdate, false);
  }

  private requireOwnedBoard(
    db: PgPool | PoolClient,
    identity: TaskboardIdentity,
    boardId: string,
    forUpdate: boolean,
  ): Promise<TaskBoard> {
    return loadStoredBoard(this, db, identity, boardId, forUpdate, true);
  }

  async requireTask(
    db: PgPool | PoolClient,
    identity: TaskboardIdentity,
    taskId: string,
    forUpdate: boolean, creationClaimToken?: string,
  ): Promise<TaskBoardTask> {
    return (await this.requireTaskWithBoard(db, identity, taskId, forUpdate, creationClaimToken)).task;
  }
  async requireTaskWithBoard(
    db: PgPool | PoolClient,
    identity: TaskboardIdentity,
    taskId: string,
    forUpdate: boolean, creationClaimToken?: string,
  ) {
    return requireStoredTaskWithBoard(this, db, identity, taskId, forUpdate, creationClaimToken);
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
