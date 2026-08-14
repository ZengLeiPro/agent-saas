import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';

import {
  TASKBOARD_DEFAULT_PROMPT,
  TASKBOARD_EXECUTION_PURPOSES,
  TASKBOARD_EXECUTION_STATUSES,
  type TaskBoard,
  type TaskBoardComment,
  type TaskBoardCommentCreateInput,
  type TaskBoardCreateInput,
  type TaskBoardExecution,
  type TaskBoardExecutionStartResult,
  type TaskBoardPatchInput,
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
  continuationOutboxIndexSql,
  continuationOutboxTableSql,
  runContinuationOutboxMigrations,
  enqueueContinuation,
  finishContinuation,
  markContinuationDispatchSucceeded,
  releaseContinuationReconcile,
  retryContinuationDispatch,
} from './continuationOutbox.js';
import { executionFieldMigrationSql, resolveExecutionPurpose, taskFieldMigrationSql } from './executionFields.js';
import {
  claimExecutionDispatch,
  claimExecutionReconcileCandidates,
  markExecutionDispatchSucceeded,
  retryExecutionDispatch,
  runExecutionOutboxMigrations,
} from './executionOutboxStore.js';
import { moveTaskFromReviewExecution } from './executionTaskMove.js';
import {
  boardModelMigrationSql,
  boardPromptMigrationSql,
  boardVisibilityMigrationSql,
  normalizeBoardPrompt,
  normalizeModel,
  rowToBoard,
} from './boardFields.js';
import {
  assertActiveBoard,
  assertExpectedVersion,
  assertWritableTask,
  assertExecutionConfiguration,
  applyCommentAuthorDisplayName,
  isTerminalExecutionStatus,
  isUniqueViolation,
  mapActiveBoardNameError,
  normalizeAttachments,
  normalizeLabels,
  quoteSqlLiteral,
  optionalText,
  requireText,
  rowToComment,
  rowToExecutionModelContext,
  rowToExecution,
  rowToTask,
  sanitizeIdentifier,
  toIso,
  validateMoveNeighbors,
} from './storeHelpers.js';
import { assertBoardHasNoActiveRuns, assertTaskHasNoActiveRuns, finalizeExecutionForArchivedTask } from './archiveGuard.js';
import { taskFieldsMigrationSql, taskTableSql } from './taskFields.js';
import {
  TaskboardNotFoundError,
  TaskboardValidationError,
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
  type TaskboardService,
  type TaskboardTaskListFilter,
} from './types.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

const DEFAULT_SORT_GAP = 1024;
const MIN_SORT_GAP = 1e-7;
export { TASKBOARD_TABLE_PREFIX_MAX_LENGTH } from './storeHelpers.js';

export interface PgTaskboardStoreOptions {
  pool: PgPool;
  tablePrefix?: string;
}

export class PgTaskboardStore implements TaskboardService, TaskboardExecutionStore {
  readonly pool: PgPool;
  readonly boardsTable: string;
  readonly tasksTable: string;
  readonly commentsTable: string;
  readonly executionsTable: string;
  readonly executionOutboxTable: string;
  readonly continuationOutboxTable: string;

  constructor(options: PgTaskboardStoreOptions) {
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.pool = options.pool;
    this.boardsTable = `${prefix}_taskboards`;
    this.tasksTable = `${prefix}_taskboard_tasks`;
    this.commentsTable = `${prefix}_taskboard_comments`;
    this.executionsTable = `${prefix}_taskboard_execs`;
    this.executionOutboxTable = `${prefix}_taskboard_exec_outbox`;
    this.continuationOutboxTable = `${prefix}_taskboard_cont_outbox`;
  }
  async init(): Promise<void> {
    const lockKey = `${this.boardsTable}:init`;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.boardsTable} (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          visibility TEXT NOT NULL DEFAULT 'personal'
            CHECK (visibility IN ('personal', 'organization')),
          prompt TEXT NOT NULL DEFAULT ${quoteSqlLiteral(TASKBOARD_DEFAULT_PROMPT)},
          model TEXT,
          next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number >= 1),
          version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
          archived_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(boardPromptMigrationSql(this.boardsTable));
      await client.query(boardModelMigrationSql(this.boardsTable));
      await client.query(boardVisibilityMigrationSql(this.boardsTable));
      await client.query(taskTableSql(this.tasksTable, this.boardsTable));
      await client.query(taskFieldsMigrationSql(this.tasksTable));
      await client.query(taskFieldMigrationSql(this.tasksTable));
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.commentsTable} (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES ${this.tasksTable}(id),
          body TEXT NOT NULL,
          attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
          author_type TEXT NOT NULL DEFAULT 'user'
            CHECK (author_type IN ('user', 'agent', 'system')),
          author_id TEXT NOT NULL,
          author_name TEXT NOT NULL,
          continuation_eligible BOOLEAN NOT NULL DEFAULT true,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        ALTER TABLE ${this.commentsTable} ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE ${this.commentsTable} ADD COLUMN IF NOT EXISTS continuation_eligible BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE ${this.commentsTable} ALTER COLUMN continuation_eligible SET DEFAULT true;
        ALTER TABLE ${this.commentsTable} ADD COLUMN IF NOT EXISTS continuation_run_id TEXT;
        ALTER TABLE ${this.commentsTable}
          DROP CONSTRAINT IF EXISTS ${this.commentsTable}_author_type_check;
        ALTER TABLE ${this.commentsTable}
          ADD CONSTRAINT ${this.commentsTable}_author_type_check
          CHECK (author_type IN ('user', 'agent', 'system'))
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.executionsTable} (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES ${this.tasksTable}(id),
          run_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          status TEXT NOT NULL
            CHECK (status IN (${TASKBOARD_EXECUTION_STATUSES.map(quoteSqlLiteral).join(', ')})),
          purpose TEXT NOT NULL DEFAULT 'work'
            CHECK (purpose IN (${TASKBOARD_EXECUTION_PURPOSES.map(quoteSqlLiteral).join(', ')})),
          requested_by TEXT NOT NULL,
          error TEXT,
          started_at TIMESTAMPTZ,
          finished_at TIMESTAMPTZ,
          last_reconciled_at TIMESTAMPTZ,
          reconcile_lease_id TEXT,
          reconcile_lease_expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(executionFieldMigrationSql(this.executionsTable));
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.executionOutboxTable} (
          run_id TEXT PRIMARY KEY REFERENCES ${this.executionsTable}(run_id),
          execution_id TEXT NOT NULL REFERENCES ${this.executionsTable}(id),
          payload JSONB NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'dispatching', 'dispatched')),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          lease_id TEXT,
          lease_expires_at TIMESTAMPTZ,
          last_error TEXT,
          dispatched_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(continuationOutboxTableSql(
        this.continuationOutboxTable,
        this.tasksTable,
        this.commentsTable,
      ));
      await runExecutionOutboxMigrations(this, client);
      await runContinuationOutboxMigrations(this, client, this.executionsTable);
      await client.query(`DROP INDEX IF EXISTS ${this.boardsTable}_active_name_uidx`);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${this.boardsTable}_personal_name_uidx `
        + `ON ${this.boardsTable} (tenant_id, owner_user_id, lower(name)) `
        + `WHERE archived_at IS NULL AND visibility='personal'`,
      );
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${this.boardsTable}_org_name_uidx `
        + `ON ${this.boardsTable} (tenant_id, lower(name)) `
        + `WHERE archived_at IS NULL AND visibility='organization'`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.boardsTable}_access_idx `
        + `ON ${this.boardsTable} (tenant_id, visibility, owner_user_id, updated_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.tasksTable}_board_column_idx `
        + `ON ${this.tasksTable} (board_id, status, sort_order)`,
      );
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${this.tasksTable}_client_request_uidx ON ${this.tasksTable} (board_id, client_request_id) WHERE client_request_id IS NOT NULL`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.tasksTable}_board_archived_idx `
        + `ON ${this.tasksTable} (board_id, archived_at, updated_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.commentsTable}_task_idx `
        + `ON ${this.commentsTable} (task_id, created_at ASC)`,
      );
      await client.query(`DROP INDEX IF EXISTS ${this.commentsTable}_continuation_run_uidx`);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.commentsTable}_continuation_run_idx ON ${this.commentsTable} (continuation_run_id) WHERE continuation_run_id IS NOT NULL`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.executionsTable}_task_idx `
        + `ON ${this.executionsTable} (task_id, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.executionsTable}_reconcile_v2_idx `
        + `ON ${this.executionsTable} (COALESCE(last_reconciled_at, '-infinity'::timestamptz), updated_at, run_id) `
        + `WHERE status IN ('queued', 'running', 'waiting_user', 'waiting_approval')`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.executionOutboxTable}_due_idx `
        + `ON ${this.executionOutboxTable} (next_attempt_at, created_at) `
        + `WHERE status IN ('pending', 'dispatching')`,
      );
      for (const indexSql of continuationOutboxIndexSql(this.continuationOutboxTable)) {
        await client.query(indexSql);
      }
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${this.executionsTable}_active_uidx `
        + `ON ${this.executionsTable} (task_id) `
        + `WHERE status IN ('queued', 'running', 'waiting_user', 'waiting_approval')`,
      );
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }
  async listBoards(identity: TaskboardIdentity, includeArchived = false): Promise<TaskBoard[]> {
    const result = await this.pool.query(
      `SELECT id, owner_user_id, name, description, visibility, prompt, model, version,
              archived_at, created_at, updated_at
         FROM ${this.boardsTable}
        WHERE tenant_id=$1
          AND (owner_user_id=$2 OR visibility='organization')
          AND ($3::boolean OR archived_at IS NULL)
        ORDER BY archived_at NULLS FIRST, updated_at DESC, id`,
      [identity.tenantId, identity.ownerUserId, includeArchived],
    );
    return result.rows.map((row) => rowToBoard(row, identity.ownerUserId));
  }
  async createBoard(identity: TaskboardIdentity, input: TaskBoardCreateInput): Promise<TaskBoard> {
    const name = requireText(input.name, 'Board name');
    const description = optionalText(input.description);
    const prompt = normalizeBoardPrompt(input.prompt ?? TASKBOARD_DEFAULT_PROMPT);
    const model = normalizeModel(input.model);
    const visibility = input.visibility ?? 'personal';
    try {
      const result = await this.pool.query(
        `INSERT INTO ${this.boardsTable}
           (id, tenant_id, owner_user_id, name, description, visibility, prompt, model, next_task_number, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,1)
         RETURNING id, owner_user_id, name, description, visibility, prompt, model, version,
                   archived_at, created_at, updated_at`,
        [randomUUID(), identity.tenantId, identity.ownerUserId, name, description, visibility, prompt, model],
      );
      return rowToBoard(result.rows[0], identity.ownerUserId);
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
      try {
        const result = await client.query(
          `UPDATE ${this.boardsTable}
              SET ${assignments.join(', ')}
            WHERE id=$1 AND tenant_id=$2 AND owner_user_id=$3
            RETURNING id, owner_user_id, name, description, visibility, prompt, model, version,
                      archived_at, created_at, updated_at`,
          params,
        );
        return rowToBoard(result.rows[0], identity.ownerUserId);
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
          RETURNING id, owner_user_id, name, description, visibility, prompt, model, version,
                    archived_at, created_at, updated_at`,
        [boardId, identity.tenantId, identity.ownerUserId],
      );
      return rowToBoard(result.rows[0], identity.ownerUserId);
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
            RETURNING id, owner_user_id, name, description, visibility, prompt, model, version,
                    archived_at, created_at, updated_at`,
          [boardId, identity.tenantId, identity.ownerUserId],
        );
        return rowToBoard(result.rows[0], identity.ownerUserId);
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
    const conditions = [
      't.board_id=$1',
      'b.tenant_id=$2',
      "(b.owner_user_id=$3 OR b.visibility='organization')",
      '($4::boolean OR t.archived_at IS NULL)',
    ];
    const params: unknown[] = [boardId, identity.tenantId, identity.ownerUserId, filter.includeArchived === true];
    if (filter.statuses?.length) {
      params.push(filter.statuses);
      conditions.push(`t.status=ANY($${params.length}::text[])`);
    }
    if (filter.priorities?.length) {
      params.push(filter.priorities);
      conditions.push(`t.priority=ANY($${params.length}::text[])`);
    }
    const search = filter.search?.trim();
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(
        t.identifier ILIKE $${params.length}
        OR t.title ILIKE $${params.length}
        OR t.description ILIKE $${params.length}
        OR t.branch ILIKE $${params.length}
        OR EXISTS (SELECT 1 FROM unnest(t.labels) AS label WHERE label ILIKE $${params.length})
      )`);
    }
    const result = await this.pool.query(
      `SELECT t.*,
              (SELECT count(*)::int FROM ${this.commentsTable} c WHERE c.task_id=t.id) AS comment_count
         FROM ${this.tasksTable} t
         JOIN ${this.boardsTable} b ON b.id=t.board_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY t.archived_at NULLS FIRST, t.status, t.sort_order, t.created_at, t.id`,
      params,
    );
    return result.rows.map(rowToTask);
  }
  async createTask(identity: TaskboardIdentity, boardId: string, input: TaskBoardTaskCreateInput): Promise<TaskBoardTask> {
    return this.withTransaction(async (client) => {
      const board = await this.requireBoard(client, identity, boardId, true);
      assertActiveBoard(board);
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
           (id, board_id, identifier, title, description, branch, attachments, status, priority, labels,
            sort_order, due_at, model, creator_user_id, creator_name, completed_at, client_request_id, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,
                 CASE WHEN $8='done' THEN now() END,$16,1)`,
        [
          taskId,
          boardId,
          `TASK-${taskNumber}`,
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
          identity.ownerUserId,
          identity.displayName?.trim() || identity.username,
          optionalText(input.clientRequestId),
        ],
      );
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
      assertExpectedVersion(loaded.task, input.expectedVersion);
      assertWritableTask(loaded.task, loaded.boardArchivedAt);
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
      assertExpectedVersion(loaded.task, input.expectedVersion);
      assertWritableTask(loaded.task, loaded.boardArchivedAt);
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

  async createComment(identity: TaskboardIdentity, taskId: string, input: TaskBoardCommentCreateInput): Promise<TaskBoardComment> {
    return this.withTransaction(async (client) => {
      const loaded = await this.requireTaskWithBoard(client, identity, taskId, true);
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
      return rowToComment(result.rows[0]);
    });
  }

  listExecutions(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardExecution[]> {
    return listTaskExecutions(this, identity, taskId);
  }

  getExecutionModelContext(identity: TaskboardIdentity, taskId: string): Promise<TaskboardExecutionModelContext> {
    return loadExecutionModelContext(this, identity, taskId);
  }
  async claimExecution(
    identity: TaskboardIdentity,
    taskId: string,
    input: TaskboardExecutionClaimInput,
  ): Promise<TaskBoardExecutionStartResult> {
    return this.withTransaction(async (client) => {
      const loaded = await this.requireTaskWithBoard(client, identity, taskId, true);
      assertExpectedVersion(loaded.task, input.expectedVersion);
      assertWritableTask(loaded.task, loaded.boardArchivedAt);
      assertExecutionConfiguration(
        loaded.task.model ?? loaded.boardModel,
        input.configuredModelRef,
        loaded.boardOwnerUserId,
        input.executionOwnerUserId,
      );
      const purpose = input.allowWorkFromCurrentStatus
        ? 'work'
        : resolveExecutionPurpose(loaded.task.status, input.purpose);
      const duplicate = await client.query(
        `SELECT * FROM ${this.executionsTable} WHERE id=$1 OR run_id=$2 LIMIT 1`,
        [input.executionId, input.runId],
      );
      if (duplicate.rows[0]) {
        const execution = rowToExecution(duplicate.rows[0]);
        if (execution.taskId !== taskId || execution.purpose !== purpose) {
          throw new TaskboardValidationError('Execution idempotency key conflict');
        }
        return { task: loaded.task, execution };
      }
      const active = await client.query(
        `SELECT 1 WHERE EXISTS (
           SELECT 1 FROM ${this.executionsTable}
            WHERE task_id=$1 AND status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
         ) OR EXISTS (
           SELECT 1 FROM ${this.continuationOutboxTable}
            WHERE task_id=$1 AND status<>'completed'
         )`,
        [taskId],
      );
      if (active.rows[0]) {
        throw new TaskboardValidationError(
          'Task already has an active Agent execution',
          'TASKBOARD_EXECUTION_ACTIVE',
        );
      }

      const sortOrder = await nextTaskColumnSortOrder(
        this,
        client,
        identity,
        loaded.task.boardId,
        taskId,
        'in_progress',
      );

      let execution: TaskBoardExecution;
      try {
        const inserted = await client.query(
          `INSERT INTO ${this.executionsTable}
             (id, task_id, run_id, session_id, status, purpose, requested_by)
           VALUES ($1,$2,$3,$4,'queued',$5,$6)
           RETURNING *`,
          [input.executionId, taskId, input.runId, input.sessionId, purpose, identity.ownerUserId],
        );
        await client.query(
          `INSERT INTO ${this.executionOutboxTable}
             (run_id, execution_id, payload)
           VALUES ($1,$2,$3::jsonb)`,
          [input.runId, input.executionId, JSON.stringify(input.dispatch)],
        );
        execution = rowToExecution(inserted.rows[0]);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TaskboardValidationError(
            'Task already has an active Agent execution',
            'TASKBOARD_EXECUTION_ACTIVE',
          );
        }
        throw error;
      }

      await client.query(
        `UPDATE ${this.commentsTable}
            SET continuation_run_id=$2, updated_at=now()
          WHERE task_id=$1 AND author_type='user' AND continuation_eligible=true
            AND continuation_run_id IS NULL`,
        [taskId, input.runId],
      );
      await client.query(
        `UPDATE ${this.tasksTable}
            SET status='in_progress', sort_order=$2, completed_at=NULL,
                version=version+1, updated_at=now()
          WHERE id=$1`,
        [taskId, sortOrder],
      );
      return {
        task: await this.requireTask(client, identity, taskId, false),
        execution,
      };
    });
  }
  getExecutionContextByRunId(runId: string): Promise<TaskboardExecutionContext | null> {
    return loadExecutionContext(this, runId);
  }

  getContinuationContext(identity: TaskboardIdentity, taskId: string, commentId: string) {
    return loadContinuationContext(this, identity, taskId, commentId);
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
  async moveTaskFromExecution(identity: TaskboardIdentity, runId: string, status: 'done' | 'todo'): Promise<TaskBoardTask> {
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
    const result = await this.pool.query(
      `UPDATE ${this.executionsTable}
          SET status=$2,
              started_at=COALESCE(started_at, now()),
              updated_at=now(),
              reconcile_lease_id=NULL,
              reconcile_lease_expires_at=NULL
        WHERE run_id=$1
          AND status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
        RETURNING *`,
      [runId, status],
    );
    return result.rows[0] ? rowToExecution(result.rows[0]) : null;
  }

  async setExecutionStatusFromReconcile(
    runId: string,
    status: 'running' | 'waiting_user' | 'waiting_approval',
    leaseId: string,
  ): Promise<TaskBoardExecution | null> {
    const result = await this.pool.query(
      `UPDATE ${this.executionsTable}
          SET status=$2,
              started_at=COALESCE(started_at, now()),
              updated_at=now()
        WHERE run_id=$1
          AND reconcile_lease_id=$3
          AND reconcile_lease_expires_at > clock_timestamp()
          AND status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
        RETURNING *`,
      [runId, status, leaseId],
    );
    return result.rows[0] ? rowToExecution(result.rows[0]) : null;
  }

  async completeExecution(
    runId: string,
    input: TaskboardExecutionCompletionInput,
  ): Promise<TaskBoardExecutionStartResult | null> {
    return this.completeExecutionInternal(runId, input);
  }

  async completeExecutionFromReconcile(
    runId: string,
    input: TaskboardExecutionCompletionInput,
    leaseId: string,
  ): Promise<TaskBoardExecutionStartResult | null> {
    return this.completeExecutionInternal(runId, input, leaseId);
  }

  private async completeExecutionInternal(
    runId: string,
    input: TaskboardExecutionCompletionInput,
    reconcileLeaseId?: string,
  ): Promise<TaskBoardExecutionStartResult | null> {
    const ownership = await this.pool.query(
      `SELECT e.task_id, b.tenant_id, b.owner_user_id
         FROM ${this.executionsTable} e
         JOIN ${this.tasksTable} t ON t.id=e.task_id
         JOIN ${this.boardsTable} b ON b.id=t.board_id
        WHERE e.run_id=$1`,
      [runId],
    );
    if (!ownership.rows[0]) return null;
    const identity: TaskboardIdentity = {
      tenantId: String(ownership.rows[0].tenant_id),
      ownerUserId: String(ownership.rows[0].owner_user_id),
      username: '',
    };
    const taskId = String(ownership.rows[0].task_id);

    return this.withTransaction(async (client) => {
      const loaded = await this.requireTaskWithBoard(client, identity, taskId, true);
      const executionResult = await client.query(
        `SELECT *,
                ($2::text IS NULL OR (
                  reconcile_lease_id=$2 AND reconcile_lease_expires_at > clock_timestamp()
                )) AS reconcile_lease_valid
           FROM ${this.executionsTable}
          WHERE run_id=$1
          FOR UPDATE`,
        [runId, reconcileLeaseId ?? null],
      );
      if (!executionResult.rows[0] || executionResult.rows[0].reconcile_lease_valid !== true) return null;
      const currentExecution = rowToExecution(executionResult.rows[0]);
      if (isTerminalExecutionStatus(currentExecution.status)) {
        await client.query(
          `UPDATE ${this.executionOutboxTable}
              SET status='dispatched', lease_id=NULL, lease_expires_at=NULL, updated_at=now()
            WHERE run_id=$1 AND status<>'dispatched'`,
          [runId],
        );
        return { task: loaded.task, execution: currentExecution };
      }
      const archivedResult = await finalizeExecutionForArchivedTask(
        this, client, loaded.task, loaded.boardArchivedAt, currentExecution, input,
      );
      if (archivedResult) return archivedResult;

      const targetTaskStatus = input.status === 'succeeded' ? 'in_review' : 'blocked';
      if (loaded.task.status === 'in_progress') {
        const sortOrder = await nextTaskColumnSortOrder(
          this,
          client,
          identity,
          loaded.task.boardId,
          taskId,
          targetTaskStatus,
        );
        await client.query(
          `UPDATE ${this.tasksTable}
              SET status=$2, sort_order=$3, completed_at=NULL,
                  version=version+1, updated_at=now()
            WHERE id=$1`,
          [taskId, targetTaskStatus, sortOrder],
        );
      }

      const updated = await client.query(
        `UPDATE ${this.executionsTable}
            SET status=$2, error=$3, finished_at=now(), updated_at=now(),
                reconcile_lease_id=NULL, reconcile_lease_expires_at=NULL
          WHERE run_id=$1
          RETURNING *`,
        [runId, input.status, optionalText(input.error)],
      );
      await client.query(
        `UPDATE ${this.executionOutboxTable}
            SET status='dispatched', lease_id=NULL, lease_expires_at=NULL, updated_at=now()
          WHERE run_id=$1 AND status<>'dispatched'`,
        [runId],
      );
      const authorType = input.status === 'succeeded' ? 'agent' : 'system';
      await client.query(
        `INSERT INTO ${this.commentsTable}
           (id, task_id, body, attachments, author_type, author_id, author_name, version)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,1)`,
        [randomUUID(), taskId, requireText(input.commentBody, 'Execution comment body'),
          JSON.stringify(normalizeAttachments(input.attachments)), authorType, currentExecution.id,
          input.status === 'succeeded' ? 'Agent' : '系统'],
      );
      return {
        task: await this.requireTask(client, identity, taskId, false),
        execution: rowToExecution(updated.rows[0]),
      };
    });
  }
  private async setTaskArchived(
    identity: TaskboardIdentity,
    taskId: string,
    expectedVersion: number,
    archive: boolean,
  ): Promise<TaskBoardTask> {
    return this.withTransaction(async (client) => {
      const loaded = await this.requireTaskWithBoard(client, identity, taskId, true);
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
      `SELECT id, owner_user_id, name, description, visibility, prompt, model, version,
              archived_at, created_at, updated_at
         FROM ${this.boardsTable}
        WHERE id=$1 AND tenant_id=$2
          AND (owner_user_id=$3 OR ($4::boolean=false AND visibility='organization'))
        ${forUpdate ? 'FOR UPDATE' : ''}`,
      [boardId, identity.tenantId, identity.ownerUserId, ownerOnly],
    );
    if (!result.rows[0]) throw new TaskboardNotFoundError('Board not found');
    return rowToBoard(result.rows[0], identity.ownerUserId);
  }

  private async requireTask(
    db: PgPool | PoolClient,
    identity: TaskboardIdentity,
    taskId: string,
    forUpdate: boolean,
  ): Promise<TaskBoardTask> {
    return (await this.requireTaskWithBoard(db, identity, taskId, forUpdate)).task;
  }

  private async requireTaskWithBoard(
    db: PgPool | PoolClient,
    identity: TaskboardIdentity,
    taskId: string,
    forUpdate: boolean,
  ): Promise<{
    task: TaskBoardTask;
    boardArchivedAt?: string;
    boardModel?: string;
    boardOwnerUserId: string;
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
              b.model AS board_model,
              b.owner_user_id AS board_owner_user_id,
              (SELECT count(*)::int FROM ${this.commentsTable} c WHERE c.task_id=t.id) AS comment_count
         FROM ${this.tasksTable} t
         JOIN ${this.boardsTable} b ON b.id=t.board_id
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
      ...(boardModel ? { boardModel } : {}),
      boardOwnerUserId: lockedBoard?.ownerUserId ?? String(row.board_owner_user_id),
    };
  }

  private async withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
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
