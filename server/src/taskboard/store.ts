import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';

import {
  TASKBOARD_PRIORITIES,
  TASKBOARD_STATUSES,
  type TaskBoard,
  type TaskBoardComment,
  type TaskBoardCreateInput,
  type TaskBoardPatchInput,
  type TaskBoardTask,
  type TaskBoardTaskCreateInput,
  type TaskBoardTaskMoveInput,
  type TaskBoardTaskPatchInput,
} from '../../../shared/src/types/taskboard.js';
import {
  TaskboardConflictError,
  TaskboardNotFoundError,
  TaskboardValidationError,
  type TaskboardExpectedVersionInput,
  type TaskboardIdentity,
  type TaskboardService,
  type TaskboardTaskListFilter,
} from './types.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

const DEFAULT_SORT_GAP = 1024;
const MIN_SORT_GAP = 1e-7;
const POSTGRES_IDENTIFIER_MAX_BYTES = 63;
const LONGEST_TASKBOARD_IDENTIFIER_SUFFIX = '_taskboard_tasks_board_id_identifier_key';
export const TASKBOARD_TABLE_PREFIX_MAX_LENGTH =
  POSTGRES_IDENTIFIER_MAX_BYTES - LONGEST_TASKBOARD_IDENTIFIER_SUFFIX.length;

export interface PgTaskboardStoreOptions {
  pool: PgPool;
  tablePrefix?: string;
}

export class PgTaskboardStore implements TaskboardService {
  readonly pool: PgPool;
  readonly boardsTable: string;
  readonly tasksTable: string;
  readonly commentsTable: string;

  constructor(options: PgTaskboardStoreOptions) {
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.pool = options.pool;
    this.boardsTable = `${prefix}_taskboards`;
    this.tasksTable = `${prefix}_taskboard_tasks`;
    this.commentsTable = `${prefix}_taskboard_comments`;
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
          next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number >= 1),
          version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
          archived_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.tasksTable} (
          id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL REFERENCES ${this.boardsTable}(id),
          identifier TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN (${TASKBOARD_STATUSES.map(quoteSqlLiteral).join(', ')})),
          priority TEXT NOT NULL DEFAULT 'none' CHECK (priority IN (${TASKBOARD_PRIORITIES.map(quoteSqlLiteral).join(', ')})),
          labels TEXT[] NOT NULL DEFAULT '{}',
          sort_order DOUBLE PRECISION NOT NULL,
          due_at TIMESTAMPTZ,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
          archived_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (board_id, identifier)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.commentsTable} (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES ${this.tasksTable}(id),
          body TEXT NOT NULL,
          author_type TEXT NOT NULL DEFAULT 'user' CHECK (author_type = 'user'),
          author_id TEXT NOT NULL,
          author_name TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${this.boardsTable}_active_name_uidx `
        + `ON ${this.boardsTable} (tenant_id, owner_user_id, lower(name)) WHERE archived_at IS NULL`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.boardsTable}_owner_idx `
        + `ON ${this.boardsTable} (tenant_id, owner_user_id, updated_at DESC)`,
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
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async listBoards(identity: TaskboardIdentity, includeArchived = false): Promise<TaskBoard[]> {
    const result = await this.pool.query(
      `SELECT id, name, description, version, archived_at, created_at, updated_at
         FROM ${this.boardsTable}
        WHERE tenant_id=$1 AND owner_user_id=$2
          AND ($3::boolean OR archived_at IS NULL)
        ORDER BY archived_at NULLS FIRST, updated_at DESC, id`,
      [identity.tenantId, identity.ownerUserId, includeArchived],
    );
    return result.rows.map(rowToBoard);
  }

  async createBoard(identity: TaskboardIdentity, input: TaskBoardCreateInput): Promise<TaskBoard> {
    const name = requireText(input.name, 'Board name');
    const description = optionalText(input.description);
    try {
      const result = await this.pool.query(
        `INSERT INTO ${this.boardsTable}
           (id, tenant_id, owner_user_id, name, description, next_task_number, version)
         VALUES ($1,$2,$3,$4,$5,1,1)
         RETURNING id, name, description, version, archived_at, created_at, updated_at`,
        [randomUUID(), identity.tenantId, identity.ownerUserId, name, description],
      );
      return rowToBoard(result.rows[0]);
    } catch (error) {
      throw mapActiveBoardNameError(error);
    }
  }

  async updateBoard(identity: TaskboardIdentity, boardId: string, input: TaskBoardPatchInput): Promise<TaskBoard> {
    return this.withTransaction(async (client) => {
      const current = await this.requireBoard(client, identity, boardId, true);
      assertExpectedVersion(current, input.expectedVersion);
      assertActiveBoard(current);
      if (input.name === undefined && input.description === undefined) {
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
      try {
        const result = await client.query(
          `UPDATE ${this.boardsTable}
              SET ${assignments.join(', ')}
            WHERE id=$1 AND tenant_id=$2 AND owner_user_id=$3
            RETURNING id, name, description, version, archived_at, created_at, updated_at`,
          params,
        );
        return rowToBoard(result.rows[0]);
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
      const current = await this.requireBoard(client, identity, boardId, true);
      assertExpectedVersion(current, input.expectedVersion);
      assertActiveBoard(current);
      const result = await client.query(
        `UPDATE ${this.boardsTable}
            SET archived_at=now(), version=version+1, updated_at=now()
          WHERE id=$1 AND tenant_id=$2 AND owner_user_id=$3
          RETURNING id, name, description, version, archived_at, created_at, updated_at`,
        [boardId, identity.tenantId, identity.ownerUserId],
      );
      return rowToBoard(result.rows[0]);
    });
  }

  async restoreBoard(
    identity: TaskboardIdentity,
    boardId: string,
    input: TaskboardExpectedVersionInput,
  ): Promise<TaskBoard> {
    return this.withTransaction(async (client) => {
      const current = await this.requireBoard(client, identity, boardId, true);
      assertExpectedVersion(current, input.expectedVersion);
      if (!current.archivedAt) {
        throw new TaskboardValidationError('Board is not archived', 'TASKBOARD_NOT_ARCHIVED');
      }
      try {
        const result = await client.query(
          `UPDATE ${this.boardsTable}
              SET archived_at=NULL, version=version+1, updated_at=now()
            WHERE id=$1 AND tenant_id=$2 AND owner_user_id=$3
            RETURNING id, name, description, version, archived_at, created_at, updated_at`,
          [boardId, identity.tenantId, identity.ownerUserId],
        );
        return rowToBoard(result.rows[0]);
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
      'b.owner_user_id=$3',
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
          WHERE id=$1 AND tenant_id=$2 AND owner_user_id=$3
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
            AND b.tenant_id=$3 AND b.owner_user_id=$4`,
        [boardId, status, identity.tenantId, identity.ownerUserId],
      );
      const sortOrder = Number(tailResult.rows[0]?.max_sort_order ?? 0) + DEFAULT_SORT_GAP;
      const taskId = randomUUID();
      await client.query(
        `INSERT INTO ${this.tasksTable}
           (id, board_id, identifier, title, description, status, priority, labels, sort_order, due_at, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)`,
        [
          taskId,
          boardId,
          `TASK-${taskNumber}`,
          requireText(input.title, 'Task title'),
          input.description ?? '',
          status,
          input.priority ?? 'none',
          normalizeLabels(input.labels),
          sortOrder,
          input.dueAt ?? null,
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
        && input.priority === undefined
        && input.labels === undefined
        && input.dueAt === undefined
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
      await client.query(
        `UPDATE ${this.tasksTable} t
            SET ${assignments.join(', ')}
           FROM ${this.boardsTable} b
          WHERE t.id=$1 AND t.board_id=b.id
            AND b.tenant_id=$2 AND b.owner_user_id=$3`,
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
            AND b.tenant_id=$4 AND b.owner_user_id=$5
          ORDER BY t.sort_order, t.created_at, t.id
          FOR UPDATE OF t`,
        [loaded.task.boardId, taskId, input.status, identity.tenantId, identity.ownerUserId],
      );
      const peers = peerResult.rows.map((row) => ({
        id: String(row.id),
        sortOrder: Number(row.sort_order),
      }));
      this.validateMoveNeighbors(peers, input.previousTaskId, input.nextTaskId);

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
            AND b.tenant_id=$2 AND b.owner_user_id=$3`,
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
        WHERE c.task_id=$1 AND b.tenant_id=$2 AND b.owner_user_id=$3
        ORDER BY c.created_at, c.id`,
      [taskId, identity.tenantId, identity.ownerUserId],
    );
    return result.rows.map(rowToComment);
  }

  async createComment(
    identity: TaskboardIdentity,
    taskId: string,
    input: { body: string },
  ): Promise<TaskBoardComment> {
    return this.withTransaction(async (client) => {
      const loaded = await this.requireTaskWithBoard(client, identity, taskId, true);
      assertWritableTask(loaded.task, loaded.boardArchivedAt);
      const result = await client.query(
        `INSERT INTO ${this.commentsTable}
           (id, task_id, body, author_type, author_id, author_name, version)
         VALUES ($1,$2,$3,'user',$4,$5,1)
         RETURNING *`,
        [randomUUID(), taskId, requireText(input.body, 'Comment body'), identity.ownerUserId, identity.username],
      );
      return rowToComment(result.rows[0]);
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
            AND b.tenant_id=$2 AND b.owner_user_id=$3`,
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
            AND b.tenant_id=$2 AND b.owner_user_id=$3`,
        [peer.id, identity.tenantId, identity.ownerUserId, peer.sortOrder, boardId],
      );
    }
  }

  private validateMoveNeighbors(
    peers: Array<{ id: string; sortOrder: number }>,
    previousTaskId?: string,
    nextTaskId?: string,
  ): void {
    const previousIndex = previousTaskId ? peers.findIndex((peer) => peer.id === previousTaskId) : -1;
    const nextIndex = nextTaskId ? peers.findIndex((peer) => peer.id === nextTaskId) : -1;
    if ((previousTaskId && previousIndex < 0) || (nextTaskId && nextIndex < 0)) {
      throw new TaskboardValidationError('Move neighbor is not an active task in the target column', 'TASKBOARD_INVALID_MOVE');
    }
    const valid = previousTaskId && nextTaskId
      ? nextIndex === previousIndex + 1
      : previousTaskId
        ? previousIndex === peers.length - 1
        : nextTaskId
          ? nextIndex === 0
          : peers.length === 0;
    if (!valid) {
      throw new TaskboardValidationError('Move neighbors are stale or not adjacent', 'TASKBOARD_INVALID_MOVE');
    }
  }

  private async requireBoard(
    db: PgPool | PoolClient,
    identity: TaskboardIdentity,
    boardId: string,
    forUpdate: boolean,
  ): Promise<TaskBoard> {
    const result = await db.query(
      `SELECT id, name, description, version, archived_at, created_at, updated_at
         FROM ${this.boardsTable}
        WHERE id=$1 AND tenant_id=$2 AND owner_user_id=$3
        ${forUpdate ? 'FOR UPDATE' : ''}`,
      [boardId, identity.tenantId, identity.ownerUserId],
    );
    if (!result.rows[0]) throw new TaskboardNotFoundError('Board not found');
    return rowToBoard(result.rows[0]);
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
  ): Promise<{ task: TaskBoardTask; boardArchivedAt?: string }> {
    let lockedBoard: TaskBoard | undefined;
    if (forUpdate) {
      const ownership = await db.query(
        `SELECT t.board_id
           FROM ${this.tasksTable} t
           JOIN ${this.boardsTable} b ON b.id=t.board_id
          WHERE t.id=$1 AND b.tenant_id=$2 AND b.owner_user_id=$3`,
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
              (SELECT count(*)::int FROM ${this.commentsTable} c WHERE c.task_id=t.id) AS comment_count
         FROM ${this.tasksTable} t
         JOIN ${this.boardsTable} b ON b.id=t.board_id
        WHERE t.id=$1 AND b.tenant_id=$2 AND b.owner_user_id=$3
        ${forUpdate ? 'FOR UPDATE OF t' : ''}`,
      [taskId, identity.tenantId, identity.ownerUserId],
    );
    if (!result.rows[0]) throw new TaskboardNotFoundError('Task not found');
    const row = result.rows[0];
    const boardArchivedAt = lockedBoard?.archivedAt
      ?? (row.board_archived_at ? toIso(row.board_archived_at) : undefined);
    return {
      task: rowToTask(row),
      ...(boardArchivedAt ? { boardArchivedAt } : {}),
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

function rowToBoard(row: Record<string, unknown>): TaskBoard {
  return {
    id: String(row.id),
    name: String(row.name),
    ...(row.description !== null && row.description !== undefined
      ? { description: String(row.description) }
      : {}),
    version: Number(row.version),
    ...(row.archived_at ? { archivedAt: toIso(row.archived_at) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToTask(row: Record<string, unknown>): TaskBoardTask {
  return {
    id: String(row.id),
    boardId: String(row.board_id),
    identifier: String(row.identifier),
    title: String(row.title),
    description: String(row.description ?? ''),
    status: String(row.status) as TaskBoardTask['status'],
    priority: String(row.priority) as TaskBoardTask['priority'],
    labels: Array.isArray(row.labels) ? row.labels.map(String) : [],
    sortOrder: Number(row.sort_order),
    ...(row.due_at ? { dueAt: toIso(row.due_at) } : {}),
    commentCount: Number(row.comment_count ?? 0),
    version: Number(row.version),
    ...(row.archived_at ? { archivedAt: toIso(row.archived_at) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function rowToComment(row: Record<string, unknown>): TaskBoardComment {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    body: String(row.body),
    authorType: 'user',
    authorId: String(row.author_id),
    authorName: String(row.author_name),
    version: Number(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function assertActiveBoard(board: TaskBoard): void {
  if (board.archivedAt) {
    throw new TaskboardValidationError('Archived boards are read-only', 'TASKBOARD_BOARD_ARCHIVED');
  }
}

function assertWritableTask(task: TaskBoardTask, boardArchivedAt?: string): void {
  if (boardArchivedAt) {
    throw new TaskboardValidationError('Archived boards are read-only', 'TASKBOARD_BOARD_ARCHIVED');
  }
  if (task.archivedAt) {
    throw new TaskboardValidationError('Archived tasks are read-only', 'TASKBOARD_TASK_ARCHIVED');
  }
}

function assertExpectedVersion<T extends TaskBoard | TaskBoardTask>(current: T, expectedVersion: number): void {
  if (current.version !== expectedVersion) throw new TaskboardConflictError(current);
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TaskboardValidationError(`${label} is required`);
  return normalized;
}

function optionalText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeLabels(labels: string[] | undefined): string[] {
  return [...new Set((labels ?? []).map((label) => label.trim()).filter(Boolean))];
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function mapActiveBoardNameError(error: unknown): unknown {
  if (isUniqueViolation(error)) {
    return new TaskboardValidationError(
      'An active board with this name already exists',
      'TASKBOARD_BOARD_NAME_EXISTS',
    );
  }
  return error;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === '23505');
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid PostgreSQL identifier: ${value}`);
  }
  if (Buffer.byteLength(value, 'utf8') > TASKBOARD_TABLE_PREFIX_MAX_LENGTH) {
    throw new Error(
      `PostgreSQL table prefix is too long for taskboard identifiers: max ${TASKBOARD_TABLE_PREFIX_MAX_LENGTH} bytes`,
    );
  }
  return value;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
