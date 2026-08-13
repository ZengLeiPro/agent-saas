import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';

import {
  TASKBOARD_DEFAULT_PROMPT,
  TASKBOARD_EXECUTION_PURPOSES,
  TASKBOARD_EXECUTION_STATUSES,
  TASKBOARD_PRIORITIES,
  TASKBOARD_STATUSES,
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
import { executionFieldMigrationSql, resolveExecutionPurpose, taskFieldMigrationSql } from './executionFields.js';
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
  rowToExecutionReconcileCandidate,
  rowToExecution,
  rowToExecutionDispatch,
  rowToTask,
  sanitizeIdentifier,
  toIso,
  validateMoveNeighbors,
} from './storeHelpers.js';
import {
  TaskboardNotFoundError,
  TaskboardValidationError,
  type TaskboardExecutionClaimInput,
  type TaskboardExecutionCompletionInput,
  type TaskboardExecutionContext,
  type TaskboardExecutionDispatch,
  type TaskboardExecutionModelContext,
  type TaskboardExecutionReconcileCandidate,
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

  constructor(options: PgTaskboardStoreOptions) {
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.pool = options.pool;
    this.boardsTable = `${prefix}_taskboards`;
    this.tasksTable = `${prefix}_taskboard_tasks`;
    this.commentsTable = `${prefix}_taskboard_comments`;
    this.executionsTable = `${prefix}_taskboard_execs`;
    this.executionOutboxTable = `${prefix}_taskboard_exec_outbox`;
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
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.tasksTable} (
          id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL REFERENCES ${this.boardsTable}(id),
          identifier TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          branch TEXT,
          attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
          status TEXT NOT NULL CHECK (status IN (${TASKBOARD_STATUSES.map(quoteSqlLiteral).join(', ')})),
          priority TEXT NOT NULL DEFAULT 'none' CHECK (priority IN (${TASKBOARD_PRIORITIES.map(quoteSqlLiteral).join(', ')})),
          labels TEXT[] NOT NULL DEFAULT '{}',
          sort_order DOUBLE PRECISION NOT NULL,
          due_at TIMESTAMPTZ,
          model TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
          archived_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (board_id, identifier)
        )
      `);
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
          version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        ALTER TABLE ${this.commentsTable} ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
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
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.tasksTable}_board_archived_idx `
        + `ON ${this.tasksTable} (board_id, archived_at, updated_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.commentsTable}_task_idx `
        + `ON ${this.commentsTable} (task_id, created_at ASC)`,
      );
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

  async createTask(
    identity: TaskboardIdentity,
    boardId: string,
    input: TaskBoardTaskCreateInput,
  ): Promise<TaskBoardTask> {
    return this.withTransaction(async (client) => {
      const board = await this.requireBoard(client, identity, boardId, true);
      assertActiveBoard(board);
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
           (id, board_id, identifier, title, description, branch, attachments, status, priority, labels, sort_order, due_at, model, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,1)`,
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
            SET status=$4, sort_order=$5, version=t.version+1, updated_at=now()
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
           (id, task_id, body, attachments, author_type, author_id, author_name, version)
         VALUES ($1,$2,$3,$4::jsonb,'user',$5,$6,1)
         RETURNING *`,
        [randomUUID(), taskId, body, JSON.stringify(attachments), identity.ownerUserId,
          identity.displayName || identity.username],
      );
      return rowToComment(result.rows[0]);
    });
  }

  async listExecutions(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardExecution[]> {
    await this.requireTask(this.pool, identity, taskId, false);
    const result = await this.pool.query(
      `SELECT e.*
         FROM ${this.executionsTable} e
         JOIN ${this.tasksTable} t ON t.id=e.task_id
         JOIN ${this.boardsTable} b ON b.id=t.board_id
        WHERE e.task_id=$1 AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT 50`,
      [taskId, identity.tenantId, identity.ownerUserId],
    );
    return result.rows.map(rowToExecution);
  }

  async getExecutionModelContext(
    identity: TaskboardIdentity,
    taskId: string,
  ): Promise<TaskboardExecutionModelContext> {
    const result = await this.pool.query(
      `SELECT t.model AS task_model, b.model AS board_model, b.owner_user_id AS board_owner_user_id
         FROM ${this.tasksTable} t
         JOIN ${this.boardsTable} b ON b.id=t.board_id
        WHERE t.id=$1 AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')`,
      [taskId, identity.tenantId, identity.ownerUserId],
    );
    if (!result.rows[0]) throw new TaskboardNotFoundError('Task not found');
    return rowToExecutionModelContext(result.rows[0]);
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
      const purpose = resolveExecutionPurpose(loaded.task.status, input.purpose);
      const active = await client.query(
        `SELECT id FROM ${this.executionsTable}
          WHERE task_id=$1 AND status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
          LIMIT 1`,
        [taskId],
      );
      if (active.rows[0]) {
        throw new TaskboardValidationError(
          'Task already has an active Agent execution',
          'TASKBOARD_EXECUTION_ACTIVE',
        );
      }

      const peers = await client.query(
        `SELECT t.sort_order
           FROM ${this.tasksTable} t
           JOIN ${this.boardsTable} b ON b.id=t.board_id
          WHERE t.board_id=$1 AND t.id<>$2 AND t.status='in_progress' AND t.archived_at IS NULL
            AND b.tenant_id=$3 AND (b.owner_user_id=$4 OR b.visibility='organization')
          ORDER BY t.sort_order DESC, t.created_at DESC, t.id DESC
          FOR UPDATE OF t`,
        [loaded.task.boardId, taskId, identity.tenantId, identity.ownerUserId],
      );
      const lastSortOrder = peers.rows[0] ? Number(peers.rows[0].sort_order) : 0;
      const sortOrder = Number.isFinite(lastSortOrder) ? lastSortOrder + DEFAULT_SORT_GAP : DEFAULT_SORT_GAP;

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
        `UPDATE ${this.tasksTable}
            SET status='in_progress', sort_order=$2, version=version+1, updated_at=now()
          WHERE id=$1`,
        [taskId, sortOrder],
      );
      return {
        task: await this.requireTask(client, identity, taskId, false),
        execution,
      };
    });
  }

  async getExecutionContextByRunId(runId: string): Promise<TaskboardExecutionContext | null> {
    const result = await this.pool.query(
      `SELECT e.*, b.tenant_id, b.owner_user_id, b.prompt AS board_prompt
         FROM ${this.executionsTable} e
         JOIN ${this.tasksTable} t ON t.id=e.task_id
         JOIN ${this.boardsTable} b ON b.id=t.board_id
        WHERE e.run_id=$1`,
      [runId],
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    const identity: TaskboardIdentity = {
      tenantId: String(row.tenant_id),
      ownerUserId: String(row.owner_user_id),
      username: '',
    };
    const execution = rowToExecution(row);
    return {
      identity,
      task: await this.requireTask(this.pool, identity, execution.taskId, false),
      boardPrompt: String(row.board_prompt ?? ''),
      comments: await this.listComments(identity, execution.taskId),
      execution,
    };
  }

  async moveTaskFromExecution(identity: TaskboardIdentity, runId: string, status: 'done' | 'todo'): Promise<TaskBoardTask> {
    return moveTaskFromReviewExecution(this, identity, runId, status);
  }
  async claimExecutionDispatch(
    runId: string | undefined,
    leaseId: string,
  ): Promise<TaskboardExecutionDispatch | null> {
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT o.run_id
           FROM ${this.executionOutboxTable} o
           JOIN ${this.executionsTable} e ON e.run_id=o.run_id
          WHERE ($2::text IS NULL OR o.run_id=$2)
            AND e.status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
            AND (
              (o.status='pending' AND o.next_attempt_at <= now())
              OR (o.status='dispatching' AND o.lease_expires_at <= now())
            )
          ORDER BY o.next_attempt_at, o.created_at, o.run_id
          FOR UPDATE OF o SKIP LOCKED
          LIMIT 1
       ), claimed AS (
         UPDATE ${this.executionOutboxTable} o
            SET status='dispatching',
                attempt_count=o.attempt_count+1,
                lease_id=$1,
                lease_expires_at=now() + interval '60 seconds',
                updated_at=now()
           FROM candidate c
          WHERE o.run_id=c.run_id
          RETURNING o.*
       )
       SELECT c.*, e.id AS actual_execution_id, e.task_id AS actual_task_id,
              e.session_id AS actual_session_id, b.tenant_id, b.owner_user_id
         FROM claimed c
         JOIN ${this.executionsTable} e ON e.run_id=c.run_id
         JOIN ${this.tasksTable} t ON t.id=e.task_id
         JOIN ${this.boardsTable} b ON b.id=t.board_id`,
      [leaseId, runId ?? null],
    );
    return result.rows[0] ? rowToExecutionDispatch(result.rows[0]) : null;
  }

  async markExecutionDispatchSucceeded(runId: string, leaseId: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const executionResult = await client.query(
        `SELECT status FROM ${this.executionsTable} WHERE run_id=$1 FOR UPDATE`,
        [runId],
      );
      if (!executionResult.rows[0]) return false;
      const dispatched = await client.query(
        `UPDATE ${this.executionOutboxTable}
            SET status='dispatched', lease_id=NULL, lease_expires_at=NULL,
                last_error=NULL, dispatched_at=now(), updated_at=now()
          WHERE run_id=$1 AND status='dispatching' AND lease_id=$2
          RETURNING execution_id`,
        [runId, leaseId],
      );
      if (!dispatched.rows[0]) return false;
      if (!isTerminalExecutionStatus(String(executionResult.rows[0].status))) {
        await client.query(
          `UPDATE ${this.executionsTable} SET error=NULL, updated_at=now() WHERE run_id=$1`,
          [runId],
        );
      }
      return true;
    });
  }

  async retryExecutionDispatch(
    runId: string,
    leaseId: string,
    error: string,
    delayMs: number,
  ): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const executionResult = await client.query(
        `SELECT status FROM ${this.executionsTable} WHERE run_id=$1 FOR UPDATE`,
        [runId],
      );
      if (!executionResult.rows[0]) return false;
      if (isTerminalExecutionStatus(String(executionResult.rows[0].status))) {
        await client.query(
          `UPDATE ${this.executionOutboxTable}
              SET status='dispatched', lease_id=NULL, lease_expires_at=NULL, updated_at=now()
            WHERE run_id=$1 AND status='dispatching' AND lease_id=$2`,
          [runId, leaseId],
        );
        return false;
      }
      const message = requireText(error, 'Dispatch error');
      const retried = await client.query(
        `UPDATE ${this.executionOutboxTable}
            SET status='pending', lease_id=NULL, lease_expires_at=NULL,
                next_attempt_at=now() + ($4::double precision * interval '1 millisecond'),
                last_error=$3, updated_at=now()
          WHERE run_id=$1 AND status='dispatching' AND lease_id=$2
          RETURNING execution_id`,
        [runId, leaseId, message, Math.max(0, Math.floor(delayMs))],
      );
      if (!retried.rows[0]) return false;
      await client.query(
        `UPDATE ${this.executionsTable} SET error=$2, updated_at=now() WHERE run_id=$1`,
        [runId, message],
      );
      return true;
    });
  }

  async claimExecutionReconcileCandidates(
    staleBefore: Date,
    limit: number,
    leaseId: string,
  ): Promise<TaskboardExecutionReconcileCandidate[]> {
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT e.run_id
           FROM ${this.executionsTable} e
          WHERE e.status IN ('queued', 'running', 'waiting_user', 'waiting_approval')
            AND e.updated_at <= $1
            AND (e.reconcile_lease_expires_at IS NULL OR e.reconcile_lease_expires_at <= now())
          ORDER BY COALESCE(e.last_reconciled_at, '-infinity'::timestamptz), e.updated_at, e.run_id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       ), claimed AS (
         UPDATE ${this.executionsTable} e
            SET last_reconciled_at=now(),
                reconcile_lease_id=$3,
                reconcile_lease_expires_at=now() + interval '30 seconds'
           FROM candidates c
          WHERE e.run_id=c.run_id
          RETURNING e.run_id, e.id AS execution_id, e.session_id, e.status, e.reconcile_lease_id
       )
       SELECT c.run_id, c.execution_id, c.session_id, c.status, c.reconcile_lease_id,
              o.status AS dispatch_status
         FROM claimed c
         LEFT JOIN ${this.executionOutboxTable} o ON o.run_id=c.run_id`,
      [staleBefore, Math.max(1, Math.min(500, Math.floor(limit))), leaseId],
    );
    return result.rows.map(rowToExecutionReconcileCandidate);
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
          AND reconcile_lease_expires_at > now()
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
                  reconcile_lease_id=$2 AND reconcile_lease_expires_at > now()
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

      const targetTaskStatus = input.status === 'succeeded' ? 'in_review' : 'blocked';
      if (loaded.task.status === 'in_progress') {
        const peers = await client.query(
          `SELECT t.sort_order
             FROM ${this.tasksTable} t
             JOIN ${this.boardsTable} b ON b.id=t.board_id
            WHERE t.board_id=$1 AND t.id<>$2 AND t.status=$3 AND t.archived_at IS NULL
              AND b.tenant_id=$4 AND (b.owner_user_id=$5 OR b.visibility='organization')
            ORDER BY t.sort_order DESC, t.created_at DESC, t.id DESC
            FOR UPDATE OF t`,
          [loaded.task.boardId, taskId, targetTaskStatus, identity.tenantId, identity.ownerUserId],
        );
        const lastSortOrder = peers.rows[0] ? Number(peers.rows[0].sort_order) : 0;
        const sortOrder = Number.isFinite(lastSortOrder) ? lastSortOrder + DEFAULT_SORT_GAP : DEFAULT_SORT_GAP;
        await client.query(
          `UPDATE ${this.tasksTable}
              SET status=$2, sort_order=$3, version=version+1, updated_at=now()
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
